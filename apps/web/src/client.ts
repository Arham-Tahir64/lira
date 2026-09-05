import { createClient } from "@supabase/supabase-js";
export async function createBackend() {
  const response = await fetch("/api/config");
  if (!response.ok)
    throw new Error("Lira could not connect. Please try again.");
  const config = (await response.json()) as {
    supabaseUrl: string;
    supabasePublicKey: string;
  };
  const supabase = createClient(config.supabaseUrl, config.supabasePublicKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error("Please sign in to continue.");
    const result = await fetch(`/api/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.session.access_token}`,
        ...init.headers,
      },
    });
    if (!result.ok) {
      const error = (await result
        .json()
        .catch(() => ({ message: "Request failed." }))) as { message?: string };
      throw new Error(error.message ?? "Request failed.");
    }
    return result.status === 204
      ? (undefined as T)
      : (result.json() as Promise<T>);
  }
  return { supabase, api };
}
export type Backend = Awaited<ReturnType<typeof createBackend>>;
