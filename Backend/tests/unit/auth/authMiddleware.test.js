jest.mock("../../../src/db/prisma");

const jwt = require("jsonwebtoken");
const { getPrisma } = require("../../../src/db/prisma");
const { authUser, verifyUserToken } = require("../../../src/middlewares/auth_middleware");

const VALID_USER_ID = "11111111-1111-4111-8111-111111111111";

function sign(payload, opts) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d", ...opts });
}

describe("auth_middleware — verifyUserToken (shared by REST and Socket.IO)", () => {
  let prisma;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    getPrisma.mockReturnValue(prisma);
  });

  test("returns null for a missing token", async () => {
    expect(await verifyUserToken(null)).toBeNull();
    expect(await verifyUserToken(undefined)).toBeNull();
    expect(await verifyUserToken("")).toBeNull();
  });

  test("returns null for a garbage/malformed token", async () => {
    expect(await verifyUserToken("not-a-real-jwt")).toBeNull();
  });

  test("returns null for a token signed with the wrong secret", async () => {
    const token = jwt.sign({ id: VALID_USER_ID }, "wrong-secret", { expiresIn: "7d" });
    expect(await verifyUserToken(token)).toBeNull();
  });

  test("returns null for an expired token", async () => {
    const token = jwt.sign({ id: VALID_USER_ID }, process.env.JWT_SECRET, { expiresIn: -10 });
    expect(await verifyUserToken(token)).toBeNull();
  });

  test("returns null when the token's id claim is not a valid UUID (rejects non-UUID ids outright)", async () => {
    const token = sign({ id: "not-a-uuid" });
    expect(await verifyUserToken(token)).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  test("returns null when the JWT is valid but the user no longer exists in the DB", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const token = sign({ id: VALID_USER_ID });
    expect(await verifyUserToken(token)).toBeNull();
  });

  test("returns the user for a valid token referencing an existing user", async () => {
    const user = { id: VALID_USER_ID, email: "admin@robotx.test", role: "SUPER_ADMIN" };
    prisma.user.findUnique.mockResolvedValue(user);
    const token = sign({ id: VALID_USER_ID });
    expect(await verifyUserToken(token)).toEqual(user);
  });
});

describe("auth_middleware — authUser (REST gate)", () => {
  let prisma;
  let req;
  let res;
  let next;

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    getPrisma.mockReturnValue(prisma);
    req = { cookies: {}, headers: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
  });

  test("401s when neither cookie nor Authorization header carries a token", async () => {
    await authUser(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("accepts a valid token from the httpOnly cookie and attaches req.user", async () => {
    const user = { id: VALID_USER_ID, email: "a@b.com", role: "SUPER_ADMIN" };
    prisma.user.findUnique.mockResolvedValue(user);
    req.cookies.token = sign({ id: VALID_USER_ID });

    await authUser(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(user);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("accepts a valid token from the Authorization: Bearer header", async () => {
    const user = { id: VALID_USER_ID, email: "a@b.com", role: "SUPER_ADMIN" };
    prisma.user.findUnique.mockResolvedValue(user);
    req.headers.authorization = `Bearer ${sign({ id: VALID_USER_ID })}`;

    await authUser(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(user);
  });

  test("cookie token takes precedence over a mismatched Bearer header", async () => {
    const user = { id: VALID_USER_ID, email: "a@b.com", role: "SUPER_ADMIN" };
    prisma.user.findUnique.mockResolvedValue(user);
    req.cookies.token = sign({ id: VALID_USER_ID });
    req.headers.authorization = "Bearer garbage";

    await authUser(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("401s on an invalid token", async () => {
    req.cookies.token = "garbage.token.here";
    await authUser(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("500s when JWT_SECRET is not configured", async () => {
    const original = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      req.cookies.token = "irrelevant";
      await authUser(req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(next).not.toHaveBeenCalled();
    } finally {
      process.env.JWT_SECRET = original;
    }
  });
});
