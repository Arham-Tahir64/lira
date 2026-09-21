import { beforeAll, afterAll, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { supabaseVerifier, type VerifyIdentity } from "../src/identity.js";
let server: Server;
let base: string;
let verify: VerifyIdentity;
let privateKey: CryptoKey;
const user = randomUUID();
const session = randomUUID();
let confirmed = true;
beforeAll(async () => {
  const keys = await generateKeyPair("ES256");
  privateKey = keys.privateKey;
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "test-key",
    alg: "ES256",
  };
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.includes("jwks")) res.end(JSON.stringify({ keys: [jwk] }));
    else if (req.url === "/auth/v1/user")
      res.end(
        JSON.stringify({
          id: user,
          email: "member@example.test",
          email_confirmed_at: confirmed ? "2026-01-01" : null,
        }),
      );
    else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  verify = supabaseVerifier(base, "test-public");
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
function token(
  issuer = `${base}/auth/v1`,
  expiration = "5m",
  audience = "authenticated",
  amr: Array<{ method: string; timestamp: number }> = [],
) {
  return new SignJWT({
    session_id: session,
    amr,
    user_metadata: { email_verified: true },
  })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setSubject(user)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(privateKey);
}
it("accepts a verified signed provider identity", async () => {
  expect((await verify(await token())).id).toBe(user);
});
it("rejects invalid issuer, audience, and expired tokens", async () => {
  await expect(
    verify(await token("https://attacker.test")),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    verify(await token(undefined, "5m", "other")),
  ).rejects.toMatchObject({ status: 401 });
  await expect(verify(await token(undefined, "-1m"))).rejects.toMatchObject({
    status: 401,
  });
});
it("rejects unsigned or malformed tokens", async () => {
  await expect(verify("not-a-token")).rejects.toMatchObject({ status: 401 });
});
it("does not accept editable verification metadata as proof of email ownership", async () => {
  confirmed = false;
  await expect(verify(await token())).rejects.toMatchObject({
    status: 403,
    code: "email_unverified",
  });
  confirmed = true;
});

it("rejects privileged keys before exposing browser configuration", async () => {
  const { assertPublicSupabaseKey } = await import("../src/configuration.js");
  expect(() =>
    assertPublicSupabaseKey("sb_publishable_example_key"),
  ).not.toThrow();
  const legacy = (role: string) =>
    `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
  expect(() => assertPublicSupabaseKey(legacy("anon"))).not.toThrow();
  expect(() => assertPublicSupabaseKey(legacy("service_role"))).toThrow(
    "never a service-role",
  );
  expect(() => assertPublicSupabaseKey("sb_secret_do_not_expose")).toThrow(
    "never a service-role",
  );
});

it("uses the authentication method timestamp, not token refresh time, for recent authentication", async () => {
  const now = Math.floor(Date.now() / 1000);
  const identity = await verify(
    await token(undefined, undefined, undefined, [
      { method: "password", timestamp: now - 3600 },
      { method: "token_refresh", timestamp: now },
    ]),
  );
  expect(identity.authenticatedAt).toBe(now - 3600);
  const refreshOnly = await verify(
    await token(undefined, undefined, undefined, [
      { method: "token_refresh", timestamp: now },
    ]),
  );
  expect(refreshOnly.authenticatedAt).toBeUndefined();
});
