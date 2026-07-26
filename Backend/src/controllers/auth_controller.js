const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");

const { getPrisma } = require("../db/prisma");

let googleClient = null;
function getGoogleClient() {
  if (!googleClient) {
    googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }
  return googleClient;
}

//////////////////////////////////////////////////
// PIN AUTH
//////////////////////////////////////////////////

// Verifies a PIN for a given user. Shared by the pinAuth endpoint below and
// by the WebAuthn registration endpoint (webauthn_controller.js), which
// re-checks the PIN as a defense-in-depth gate before persisting a new
// passkey credential. Returns { ok: true } or { ok: false, status, message }
// so callers can propagate the exact same response shape pinAuth used to
// return inline.
async function verifyUserPin(prisma, userId, pin) {
  const normalizedPin = String(pin ?? "").trim();

  if (!normalizedPin) {
    return { ok: false, status: 400, message: "PIN required" };
  }

  if (!userId) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  // fetch PIN for THIS user only
  const authPin = await prisma.adminPinAuth.findUnique({
    where: { userId },
  });

  if (!authPin) {
    return { ok: false, status: 403, message: "PIN not configured" };
  }

  const stored = String(authPin.pinHash ?? "");
  const looksBcrypt = stored.startsWith("$2a$") || stored.startsWith("$2b$") || stored.startsWith("$2y$");

  // verify PIN (bcrypt preferred; allow legacy/plain pins and auto-migrate)
  let isValid = false;
  if (looksBcrypt) {
    isValid = await bcrypt.compare(normalizedPin, stored);
  } else {
    const a = Buffer.from(normalizedPin, "utf8");
    const b = Buffer.from(stored.trim(), "utf8");
    isValid = a.length === b.length && crypto.timingSafeEqual(a, b);

    // Auto-migrate plain-text PINs to bcrypt hash after first successful auth.
    if (isValid) {
      const nextHash = await bcrypt.hash(normalizedPin, 10);
      await prisma.adminPinAuth.update({
        where: { userId },
        data: { pinHash: nextHash },
      });
    }
  }

  if (!isValid) {
    return { ok: false, status: 401, message: "Invalid PIN" };
  }

  return { ok: true };
}

async function pinAuth(req, res) {
  try {
    const userId = req.user?.id;
    const prisma = getPrisma();

    const result = await verifyUserPin(prisma, userId, req.body?.pin);
    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }

    // success — no new JWT
    return res.status(200).json({
      message: "Authorized",
      authorized: true,
    });
  } catch (error) {
    console.error("PIN AUTH ERROR:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}


function getAuthCookieOptions() {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

  // Defaults that work locally (localhost ports are same-site).
  // In production behind HTTPS, set COOKIE_SECURE=true and (if needed) COOKIE_SAMESITE=none
  // for truly cross-site deployments.
  const secure = process.env.COOKIE_SECURE
    ? String(process.env.COOKIE_SECURE).toLowerCase() === "true"
    : isProd;
  const sameSite = process.env.COOKIE_SAMESITE || (isProd ? "lax" : "lax");

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

//////////////////////////////////////////////////
// LOGIN
//////////////////////////////////////////////////
async function loginUser(req, res) {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password required" });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: "Server misconfigured" });
  }

  // Find user
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      role: true,
      password: true
    }
  });

  if (!user) {
    return res.status(400).json({ message: "Invalid email or password" });
  }

  // Compare password
  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (!isPasswordValid) {
    return res.status(400).json({ message: "Invalid email or password" });
  }

  // Generate JWT
  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.cookie("token", token, getAuthCookieOptions());

  return res.status(200).json({
    message: "User logged in successfully",
    user: {
      id: user.id,
      email: user.email,
      role: user.role
    }
  });
}

//////////////////////////////////////////////////
// GOOGLE LOGIN
//////////////////////////////////////////////////
async function googleLogin(req, res) {
  const { credential } = req.body || {};

  if (!credential) {
    return res.status(400).json({ message: "Google credential required" });
  }

  if (!process.env.JWT_SECRET || !process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).json({ message: "Server misconfigured" });
  }

  let payload;
  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error) {
    return res.status(401).json({ message: "Invalid Google credential" });
  }

  if (!payload?.email || !payload.email_verified) {
    return res.status(401).json({ message: "Google account email is not verified" });
  }

  // Same account, same email: this is the merge key. We never create a new
  // account from Google sign-in — only link/authenticate an existing one —
  // so a user always ends up in the single account tied to their email,
  // whichever method they used to sign in.
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { email: payload.email },
    select: {
      id: true,
      email: true,
      role: true,
      googleId: true,
    },
  });

  if (!user) {
    return res.status(403).json({ message: "No account found for this email" });
  }

  if (user.googleId !== payload.sub) {
    await prisma.user.update({
      where: { id: user.id },
      data: { googleId: payload.sub },
    });
  }

  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.cookie("token", token, getAuthCookieOptions());

  return res.status(200).json({
    message: "User logged in successfully",
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  });
}

//////////////////////////////////////////////////
// GET ME
//////////////////////////////////////////////////
async function getMe(req, res) {
  const userId = req.user.id;

  const prisma = getPrisma();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true
    }
  });

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.status(200).json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role
    }
  });
}

//////////////////////////////////////////////////
// CHANGE PASSWORD
//////////////////////////////////////////////////
async function changePassword(req, res) {
  const userId = req.user.id;
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      message: "currentPassword and newPassword are required"
    });
  }

  // Get user
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      password: true
    }
  });

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  // Compare current password
  const isPasswordValid = await bcrypt.compare(
    currentPassword,
    user.password
  );

  if (!isPasswordValid) {
    return res.status(400).json({
      message: "Current password is incorrect"
    });
  }

  // Hash new password
  const hashedPassword = await bcrypt.hash(newPassword, 10);

  // Update in DB
  await prisma.user.update({
    where: { id: userId },
    data: { password: hashedPassword }
  });

  return res.status(200).json({
    message: "Password updated successfully"
  });
}

//////////////////////////////////////////////////
// LOGOUT
//////////////////////////////////////////////////
async function logout(req, res) {
  const opts = getAuthCookieOptions();
  // clearCookie ignores maxAge; keep other attributes consistent
  res.clearCookie("token", {
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
  });

  return res.status(200).json({
    message: "Logged out"
  });
}

module.exports = {
  loginUser,
  googleLogin,
  getMe,
  changePassword,
  logout,
  pinAuth,
  verifyUserPin,
};