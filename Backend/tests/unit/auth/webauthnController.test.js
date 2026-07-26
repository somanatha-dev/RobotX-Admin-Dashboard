jest.mock("@simplewebauthn/server");
jest.mock("../../../src/db/prisma");
jest.mock("../../../src/controllers/auth_controller", () => ({
  verifyUserPin: jest.fn(),
}));

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { getPrisma } = require("../../../src/db/prisma");
const { verifyUserPin } = require("../../../src/controllers/auth_controller");
const webauthn = require("../../../src/controllers/webauthn_controller");
const { createTestKv } = require("../../helpers/testKv");

const USER_ID = "22222222-2222-4222-8222-222222222222";
const ALLOWED_ORIGIN = "https://app.robotx.test"; // matches tests/setup/env.js FRONTEND_URL

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

describe("webauthn_controller — server-verified challenge/response flow", () => {
  let prisma;
  let kv;

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
      webAuthnCredential: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
    };
    getPrisma.mockReturnValue(prisma);
    ({ kv } = await createTestKv());
  });

  function makeReq({ body = {}, origin = ALLOWED_ORIGIN } = {}) {
    return {
      app: { locals: { kv } },
      user: { id: USER_ID },
      body,
      headers: { origin },
    };
  }

  describe("registerOptions", () => {
    test("400s when the request Origin is not on the CORS allowlist", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: "a@b.com" });
      const req = makeReq({ origin: "https://evil.example.com" });
      const res = makeRes();
      await webauthn.registerOptions(req, res);
      expect(res.statusCode).toBe(400);
      expect(generateRegistrationOptions).not.toHaveBeenCalled();
    });

    test("stores the server-generated challenge in Redis keyed by user + purpose", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: "a@b.com" });
      prisma.webAuthnCredential.findMany.mockResolvedValue([]);
      generateRegistrationOptions.mockResolvedValue({ challenge: "srv-challenge-abc" });

      const req = makeReq();
      const res = makeRes();
      await webauthn.registerOptions(req, res);

      expect(res.statusCode).toBe(200);
      const stored = await kv.get(`webauthn:regChallenge:${USER_ID}`);
      expect(stored).toBe("srv-challenge-abc");
    });

    test("404s if the user was deleted between auth and this call", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      const req = makeReq();
      const res = makeRes();
      await webauthn.registerOptions(req, res);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("register — verify + persist", () => {
    beforeEach(() => {
      verifyUserPin.mockResolvedValue({ ok: true });
    });

    test("400s when no WebAuthn response payload is sent", async () => {
      const req = makeReq({ body: { pin: "1234" } });
      const res = makeRes();
      await webauthn.register(req, res);
      expect(res.statusCode).toBe(400);
    });

    test("rejects with the PIN service's own status when PIN re-check fails (defense-in-depth)", async () => {
      verifyUserPin.mockResolvedValue({ ok: false, status: 401, message: "Invalid PIN" });
      const req = makeReq({ body: { pin: "0000", response: { id: "cred-1" } } });
      const res = makeRes();
      await webauthn.register(req, res);
      expect(res.statusCode).toBe(401);
      expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    });

    test("400s when no challenge was ever issued (expired/missing)", async () => {
      const req = makeReq({ body: { pin: "1234", response: { id: "cred-1" } } });
      const res = makeRes();
      await webauthn.register(req, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/challenge expired/i);
    });

    test("persists the credential and deletes the challenge on a verified response", async () => {
      await kv.set(`webauthn:regChallenge:${USER_ID}`, "srv-challenge", { ex: 300 });
      verifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          credentialID: "cred-xyz",
          credentialPublicKey: Buffer.from("pubkey-bytes"),
          counter: 0,
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
      });

      const req = makeReq({ body: { pin: "1234", response: { id: "cred-xyz", response: {} } } });
      const res = makeRes();
      await webauthn.register(req, res);

      expect(res.statusCode).toBe(200);
      expect(prisma.webAuthnCredential.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: USER_ID, credentialId: "cred-xyz" }) })
      );
      // Challenge must be single-use — deleted after being consumed.
      expect(await kv.get(`webauthn:regChallenge:${USER_ID}`)).toBeNull();
    });

    test("400s and deletes the challenge when verifyRegistrationResponse throws (prevents replay of a spent challenge)", async () => {
      await kv.set(`webauthn:regChallenge:${USER_ID}`, "srv-challenge", { ex: 300 });
      verifyRegistrationResponse.mockRejectedValue(new Error("bad signature"));

      const req = makeReq({ body: { pin: "1234", response: { id: "cred-xyz" } } });
      const res = makeRes();
      await webauthn.register(req, res);

      expect(res.statusCode).toBe(400);
      expect(await kv.get(`webauthn:regChallenge:${USER_ID}`)).toBeNull();
    });

    test("409s when the same authenticator is already registered (Prisma unique violation)", async () => {
      await kv.set(`webauthn:regChallenge:${USER_ID}`, "srv-challenge", { ex: 300 });
      verifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          credentialID: "dup-cred",
          credentialPublicKey: Buffer.from("k"),
          counter: 0,
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
        },
      });
      const dupErr = Object.assign(new Error("dup"), { code: "P2002" });
      prisma.webAuthnCredential.create.mockRejectedValue(dupErr);

      const req = makeReq({ body: { pin: "1234", response: { id: "dup-cred" } } });
      const res = makeRes();
      await webauthn.register(req, res);
      expect(res.statusCode).toBe(409);
    });
  });

  describe("verify — step-up authentication + replay/clone protection", () => {
    const CREDENTIAL_ID = "cred-abc";

    function storedCredential(counter) {
      return {
        id: "row-1",
        userId: USER_ID,
        credentialId: CREDENTIAL_ID,
        publicKey: Buffer.from("pubkey").toString("base64url"),
        counter: BigInt(counter),
      };
    }

    test("401s when the credential ID isn't recognized for this user", async () => {
      await kv.set(`webauthn:authChallenge:${USER_ID}`, "chal", { ex: 300 });
      prisma.webAuthnCredential.findUnique.mockResolvedValue(null);

      const req = makeReq({ body: { response: { id: CREDENTIAL_ID } } });
      const res = makeRes();
      await webauthn.verify(req, res);
      expect(res.statusCode).toBe(401);
    });

    test("accepts a verified response whose counter advanced, and persists the new counter", async () => {
      await kv.set(`webauthn:authChallenge:${USER_ID}`, "chal", { ex: 300 });
      prisma.webAuthnCredential.findUnique.mockResolvedValue(storedCredential(5));
      verifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 6 },
      });

      const req = makeReq({ body: { response: { id: CREDENTIAL_ID } } });
      const res = makeRes();
      await webauthn.verify(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.authorized).toBe(true);
      expect(prisma.webAuthnCredential.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ counter: 6n }) })
      );
    });

    test("rejects a non-advancing counter as a possible cloned authenticator", async () => {
      await kv.set(`webauthn:authChallenge:${USER_ID}`, "chal", { ex: 300 });
      prisma.webAuthnCredential.findUnique.mockResolvedValue(storedCredential(5));
      verifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 5 }, // did not advance
      });

      const req = makeReq({ body: { response: { id: CREDENTIAL_ID } } });
      const res = makeRes();
      await webauthn.verify(req, res);

      expect(res.statusCode).toBe(401);
      expect(res.body.message).toMatch(/did not advance/);
      expect(prisma.webAuthnCredential.update).not.toHaveBeenCalled();
    });

    test("allows counter 0 -> 0 for authenticators that never implement a counter (spec-legal exception)", async () => {
      await kv.set(`webauthn:authChallenge:${USER_ID}`, "chal", { ex: 300 });
      prisma.webAuthnCredential.findUnique.mockResolvedValue(storedCredential(0));
      verifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 0 },
      });

      const req = makeReq({ body: { response: { id: CREDENTIAL_ID } } });
      const res = makeRes();
      await webauthn.verify(req, res);
      expect(res.statusCode).toBe(200);
    });

    test("401s when verifyAuthenticationResponse reports verified: false", async () => {
      await kv.set(`webauthn:authChallenge:${USER_ID}`, "chal", { ex: 300 });
      prisma.webAuthnCredential.findUnique.mockResolvedValue(storedCredential(5));
      verifyAuthenticationResponse.mockResolvedValue({ verified: false, authenticationInfo: {} });

      const req = makeReq({ body: { response: { id: CREDENTIAL_ID } } });
      const res = makeRes();
      await webauthn.verify(req, res);
      expect(res.statusCode).toBe(401);
    });
  });

  describe("status", () => {
    test("reports registered:true with a count when credentials exist", async () => {
      prisma.webAuthnCredential.count.mockResolvedValue(2);
      const req = makeReq();
      const res = makeRes();
      await webauthn.status(req, res);
      expect(res.body).toEqual({ registered: true, count: 2 });
    });
  });
});
