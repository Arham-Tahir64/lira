import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import type { Backend } from "./client";
import { PasswordReset, SignIn } from "./screens/SignIn";
import { Workspace } from "./screens/Workspace";
import { AcceptInvitation } from "./screens/AcceptInvitation";
import { invitationStorageKey, captureInvitation } from "./invitation";
export function App({ backend }: { backend: Backend }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const cache = useQueryClient();
  const [invitation, setInvitation] = useState(() =>
    sessionStorage.getItem(invitationStorageKey),
  );
  const [joinedOrg, setJoinedOrg] = useState<string>();
  useEffect(() => {
    const capture = () => {
      const token = captureInvitation();
      if (token) setInvitation(token);
    };
    window.addEventListener("hashchange", capture);
    return () => window.removeEventListener("hashchange", capture);
  }, []);
  useEffect(() => {
    let active = true;
    const { data } = backend.supabase.auth.onAuthStateChange((event, next) => {
      if (active) {
        setSession(next);
        setReady(true);
        if (event === "PASSWORD_RECOVERY") setRecovery(true);
        if (event === "SIGNED_OUT") {
          cache.clear();
          setRecovery(false);
        }
      }
    });
    void backend.supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setReady(true);
      }
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [backend, cache]);
  if (!ready)
    return (
      <main className="boot" role="status">
        Opening Lira…
      </main>
    );
  if (recovery)
    return (
      <PasswordReset backend={backend} onComplete={() => setRecovery(false)} />
    );
  if (session && invitation)
    return (
      <AcceptInvitation
        backend={backend}
        token={invitation}
        email={session.user.email ?? ""}
        onDone={(orgId) => {
          sessionStorage.removeItem(invitationStorageKey);
          setInvitation(null);
          setJoinedOrg(orgId);
        }}
      />
    );
  return session ? (
    <Workspace
      key={session.user.id}
      backend={backend}
      session={session}
      initialOrgId={joinedOrg}
    />
  ) : (
    <SignIn backend={backend} />
  );
}
