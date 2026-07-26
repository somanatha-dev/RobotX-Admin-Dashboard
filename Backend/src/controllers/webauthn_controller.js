const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const { getPrisma } = require("../db/prisma");
const { isOriginAllowed } = require("../config/cors");
const { verifyUserPin } = require("./auth_controller");

const RP_NAME = "RobotX Command Console";
const CHALLENGE_TTL_SEC = 300;

// WebAuthn ceremonies run in the browser at the frontend's origin, so the RP
// ID / expected origin must reflect that origin, not the backend's own host.
// Reuses the same allowlist `authUser`'s CORS check already trusts. A missing
// Origin header is rejected outright here (same as `isOriginAllowed` itself
// now does) since these are sensitive step-up endpoints.
function resolveRpIdAndOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || !isOriginAllowed(origin)) return null;
  try {
    const url = new URL(origin);
    return { rpId: url.hostname, origin: url.origin };
  } catch {
    return null;
  }
}

function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, "");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function parseTransports(csv) {
  return csv ? csv.split(",").filter(Boolean) : undefined;
}

function challengeKey(purpose, userId) {
  return `webauthn:${purpose}Challenge:${userId}`;
}

//////////////////////////////////////////////////
// REGISTRATION OPTIONS
//////////////////////////////////////////////////
async function registerOptions(req, res) {
  const kv = req.app?.locals?.kv;
  const userId = req.user?.id;

  const rp = resolveRpIdAndOrigin(req);
  if (!rp) {
    return res.status(400).json({ message: "Origin not allowed for WebAuthn" });
  }

  const prisma = getPrisma();
  const [user, existing] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } }),
    prisma.webAuthnCredential.findMany({ where: { userId }, select: { credentialId: true, transports: true } }),
  ]);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpId,
    userID: uuidToBytes(user.id),
    userName: user.email,
    userDisplayName: user.email,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
      authenticatorAttachment: "platform",
    },
    supportedAlgorithmIDs: [-7, -257],
  });

  await kv?.set(challengeKey("reg", userId), options.challenge, { ex: CHALLENGE_TTL_SEC });

  return res.status(200).json({ options });
}

//////////////////////////////////////////////////
// REGISTRATION VERIFY + STORE
//////////////////////////////////////////////////
async function register(req, res) {
  const kv = req.app?.locals?.kv;
  const userId = req.user?.id;
  const { pin, response } = req.body || {};

  if (!response || typeof response !== "object") {
    return res.status(400).json({ message: "Missing WebAuthn response" });
  }

  const prisma = getPrisma();

  // Defense-in-depth: registering a new authenticator is security-sensitive
  // (it mints a durable credential usable for future step-up authorization),
  // so it requires the same PIN re-check the UI already gates registration
  // behind — a stolen session cookie alone shouldn't be able to plant one.
  const pinResult = await verifyUserPin(prisma, userId, pin);
  if (!pinResult.ok) {
    return res.status(pinResult.status).json({ message: pinResult.message });
  }

  const rp = resolveRpIdAndOrigin(req);
  if (!rp) {
    return res.status(400).json({ message: "Origin not allowed for WebAuthn" });
  }

  const challenge = await kv?.get(challengeKey("reg", userId));
  if (!challenge) {
    return res.status(400).json({ message: "Registration challenge expired. Please try again." });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
    });
  } catch (err) {
    await kv?.del(challengeKey("reg", userId));
    return res.status(400).json({ message: err?.message || "Passkey registration could not be verified" });
  }

  await kv?.del(challengeKey("reg", userId));

  if (!verification.verified || !verification.registrationInfo) {
    return res.status(400).json({ message: "Passkey registration could not be verified" });
  }

  const { credentialID, credentialPublicKey, counter, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  const transports = Array.isArray(response?.response?.transports)
    ? response.response.transports.join(",")
    : null;

  try {
    await prisma.webAuthnCredential.create({
      data: {
        userId,
        credentialId: credentialID,
        publicKey: Buffer.from(credentialPublicKey).toString("base64url"),
        counter: BigInt(counter),
        transports,
        deviceType: credentialDeviceType,
        backedUp: !!credentialBackedUp,
      },
    });
  } catch (err) {
    if (err?.code === "P2002") {
      return res.status(409).json({ message: "This authenticator is already registered" });
    }
    throw err;
  }

  return res.status(200).json({ message: "Passkey registered", authorized: true });
}

//////////////////////////////////////////////////
// AUTHENTICATION OPTIONS (STEP-UP)
//////////////////////////////////////////////////
async function authOptions(req, res) {
  const kv = req.app?.locals?.kv;
  const userId = req.user?.id;

  const rp = resolveRpIdAndOrigin(req);
  if (!rp) {
    return res.status(400).json({ message: "Origin not allowed for WebAuthn" });
  }

  const prisma = getPrisma();
  const credentials = await prisma.webAuthnCredential.findMany({
    where: { userId },
    select: { credentialId: true, transports: true },
  });

  if (credentials.length === 0) {
    return res.status(404).json({ message: "No passkey registered for this account" });
  }

  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: parseTransports(c.transports),
    })),
    userVerification: "required",
  });

  await kv?.set(challengeKey("auth", userId), options.challenge, { ex: CHALLENGE_TTL_SEC });

  return res.status(200).json({ options });
}

//////////////////////////////////////////////////
// AUTHENTICATION VERIFY (STEP-UP AUTHORIZATION)
//////////////////////////////////////////////////
async function verify(req, res) {
  const kv = req.app?.locals?.kv;
  const userId = req.user?.id;
  const { response } = req.body || {};

  if (!response || typeof response !== "object" || !response.id) {
    return res.status(400).json({ message: "Missing WebAuthn response" });
  }

  const rp = resolveRpIdAndOrigin(req);
  if (!rp) {
    return res.status(400).json({ message: "Origin not allowed for WebAuthn" });
  }

  const challenge = await kv?.get(challengeKey("auth", userId));
  if (!challenge) {
    return res.status(400).json({ message: "Authentication challenge expired. Please try again." });
  }

  const prisma = getPrisma();
  const credential = await prisma.webAuthnCredential.findUnique({ where: { credentialId: response.id } });

  if (!credential || credential.userId !== userId) {
    await kv?.del(challengeKey("auth", userId));
    return res.status(401).json({ message: "Passkey not recognized for this account" });
  }

  const authenticator = {
    credentialID: credential.credentialId,
    credentialPublicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
    counter: Number(credential.counter),
    transports: parseTransports(credential.transports),
  };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpId,
      authenticator,
      requireUserVerification: true,
    });
  } catch (err) {
    await kv?.del(challengeKey("auth", userId));
    return res.status(401).json({ message: err?.message || "Passkey authentication failed" });
  }

  await kv?.del(challengeKey("auth", userId));

  if (!verification.verified) {
    return res.status(401).json({ message: "Passkey authentication failed" });
  }

  // Reject a signature whose counter didn't advance — a strong signal of a
  // replayed assertion or a cloned authenticator. Authenticators that never
  // implement a counter report 0 on every ceremony (spec-legal), so the
  // check is skipped only when both the stored and new values are exactly 0.
  const previousCounter = Number(credential.counter);
  const newCounter = verification.authenticationInfo.newCounter;
  const counterIsTracked = previousCounter !== 0 || newCounter !== 0;
  if (counterIsTracked && newCounter <= previousCounter) {
    return res.status(401).json({
      message: "Passkey signature counter did not advance — possible cloned authenticator",
    });
  }

  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: { counter: BigInt(newCounter), lastUsedAt: new Date() },
  });

  return res.status(200).json({ message: "Authorized", authorized: true });
}

//////////////////////////////////////////////////
// STATUS
//////////////////////////////////////////////////
async function status(req, res) {
  const userId = req.user?.id;
  const prisma = getPrisma();
  const count = await prisma.webAuthnCredential.count({ where: { userId } });
  return res.status(200).json({ registered: count > 0, count });
}

module.exports = {
  registerOptions,
  register,
  authOptions,
  verify,
  status,
};
