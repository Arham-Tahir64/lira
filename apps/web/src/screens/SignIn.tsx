import { useState, type FormEvent } from "react";
import { ArrowRight } from "lucide-react";
import type { Backend } from "../client";
import { Brand, Notice } from "../components/primitives";
import { text, message } from "../form";
export function PasswordReset({
  backend,
  onComplete,
}: {
  backend: Backend;
  onComplete: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await backend.supabase.auth.updateUser({
        password: text(event.currentTarget, "password", false),
      });
      if (result.error) throw result.error;
      onComplete();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="sign-in">
      <Brand />
      <form onSubmit={submit}>
        <h1>Set a new password</h1>
        <label>
          New password
          <input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        {error && <Notice>{error}</Notice>}
        <button type="submit" className="primary" disabled={busy}>
          Save password
        </button>
      </form>
    </main>
  );
}
export function SignIn({ backend }: { backend: Backend }) {
  const [mode, setMode] = useState<"login" | "signup" | "reset">("login");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    const email = text(event.currentTarget, "email");
    const password = text(event.currentTarget, "password", false);
    try {
      if (mode === "reset") {
        const r = await backend.supabase.auth.resetPasswordForEmail(email, {
          redirectTo: location.origin,
        });
        if (r.error) throw r.error;
        setInfo("If an account exists, you’ll receive a password reset link.");
      } else if (mode === "signup") {
        const r = await backend.supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: location.origin },
        });
        if (r.error) throw r.error;
        setInfo("Check your email to verify your account, then sign in.");
      } else {
        const r = await backend.supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (r.error) throw r.error;
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="sign-in">
      <Brand />
      <div className="sign-in-title">
        <span className="eyebrow">A little structure. Room to do more.</span>
        <h1>
          Your club.
          <br />
          Your next thing.
        </h1>
        <p>A shared place for projects, people, and the work ahead.</p>
      </div>
      <form onSubmit={submit}>
        <h2>
          {mode === "signup"
            ? "Create your account"
            : mode === "reset"
              ? "Reset your password"
              : "Welcome back"}
        </h2>
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            placeholder="you@university.ca"
          />
        </label>
        {mode !== "reset" && (
          <label>
            Password
            <input
              name="password"
              type="password"
              minLength={mode === "signup" ? 12 : 1}
              maxLength={128}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
              required
            />
          </label>
        )}
        {error && <Notice>{error}</Notice>}
        {info && (
          <p role="status" className="success">
            {info}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy
            ? "Please wait…"
            : mode === "login"
              ? "Sign in"
              : mode === "signup"
                ? "Create account"
                : "Send reset link"}
          <ArrowRight size={16} />
        </button>
        <div className="form-links">
          <button
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setInfo("");
              setError("");
            }}
          >
            {mode === "login" ? "Create an account" : "Back to sign in"}
          </button>
          {mode === "login" && (
            <button type="button" onClick={() => setMode("reset")}>
              Forgot password?
            </button>
          )}
        </div>
      </form>
      <p className="sign-in-footer">
        Built for the people who make things happen.
      </p>
    </main>
  );
}
