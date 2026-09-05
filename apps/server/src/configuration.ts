/** Reject privileged keys before any public configuration endpoint is registered. */
export function assertPublicSupabaseKey(key: string) {
  if (key.startsWith("sb_publishable_") && key.length > 20) return;
  try {
    const parts = key.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      ) as { role?: string };
      if (payload.role === "anon") return;
    }
  } catch {
    /* Malformed key: fail closed below. */
  }
  throw new Error(
    "SUPABASE_PUBLIC_KEY must be a publishable key or legacy anon key, never a service-role/secret key.",
  );
}
