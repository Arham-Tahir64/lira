import { createRemoteJWKSet, jwtVerify } from "jose";
import { Problem } from "./problem.js";
export interface Identity {
  id: string;
  displayName: string;
  email: string;
  authenticatedAt?: number;
  issuedAt: number;
  sessionId: string;
}
export type VerifyIdentity = (token: string) => Promise<Identity>;
export function supabaseVerifier(
  url: string,
  publicKey: string,
): VerifyIdentity {
  const issuer = `${url.replace(/\/$/, "")}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: "authenticated",
        algorithms: ["ES256", "RS256"],
      });
      if (
        !payload.sub ||
        !/^[0-9a-f-]{36}$/i.test(payload.sub) ||
        !payload.iat ||
        typeof payload.session_id !== "string"
      )
        throw new Error("Incomplete identity");
      // Do not trust editable user_metadata.email_verified. The provider is authoritative.
      const response = await fetch(`${issuer}/user`, {
        headers: { apikey: publicKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429)
          throw new Problem(
            503,
            "identity_unavailable",
            "Sign-in service is temporarily unavailable.",
          );
        throw new Problem(401, "invalid_session", "Please sign in again.");
      }
      const user = (await response.json()) as {
        id?: string;
        email_confirmed_at?: string;
        email?: string;
      };
      if (user.id !== payload.sub) throw new Error("Identity mismatch");
      if (!user.email_confirmed_at || !user.email)
        throw new Problem(
          403,
          "email_unverified",
          "Verify your email before using a workspace.",
        );
      const methods = Array.isArray(payload.amr) ? payload.amr : [];
      const authenticationTimes = methods.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return [];
        const method = entry as { method?: unknown; timestamp?: unknown };
        return [
          "password",
          "oauth",
          "otp",
          "totp",
          "sso/saml",
          "magiclink",
        ].includes(String(method.method)) &&
          typeof method.timestamp === "number" &&
          Number.isFinite(method.timestamp)
          ? [method.timestamp]
          : [];
      });
      return {
        id: payload.sub,
        email: user.email.toLowerCase(),
        authenticatedAt: authenticationTimes.length
          ? Math.max(...authenticationTimes)
          : undefined,
        displayName: user.email?.split("@")[0]?.slice(0, 100) || "Member",
        issuedAt: payload.iat,
        sessionId: payload.session_id,
      };
    } catch (error) {
      if (error instanceof Problem) throw error;
      if (
        error instanceof Error &&
        ["TimeoutError", "AbortError", "TypeError"].includes(error.name)
      )
        throw new Problem(
          503,
          "identity_unavailable",
          "Sign-in service is temporarily unavailable.",
        );
      throw new Problem(401, "invalid_session", "Please sign in again.");
    }
  };
}
