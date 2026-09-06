import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Backend } from "../client";
import { Brand, Notice } from "../components/primitives";
import { message } from "../form";
export function AcceptInvitation({
  backend,
  token,
  email,
  onDone,
}: {
  backend: Backend;
  token: string;
  email: string;
  onDone: (orgId?: string) => void;
}) {
  const cache = useQueryClient();
  const accept = useMutation({
    mutationFn: () =>
      backend.api<{ orgId: string }>("/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    onSuccess: async (data) => {
      await cache.invalidateQueries({ queryKey: ["organizations"] });
      onDone(data.orgId);
    },
  });
  return (
    <main className="boot">
      <Brand />
      <h1>Join your club workspace</h1>
      <p>You’re signed in as {email}.</p>
      <p className="hint">This must match the email on the invitation.</p>
      {accept.error && <Notice>{message(accept.error)}</Notice>}
      <button
        className="primary"
        disabled={accept.isPending}
        onClick={() => accept.mutate()}
      >
        Accept invitation
      </button>
      <button onClick={() => onDone()}>Back to my workspaces</button>
    </main>
  );
}
