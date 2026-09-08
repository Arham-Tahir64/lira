import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users, Copy } from "lucide-react";
import type {
  Organization,
  RosterMember,
  Invitation,
  Team,
} from "@lira/contracts";
import type { Backend } from "../client";
import { Dialog, Notice } from "../components/primitives";
import { text, message } from "../form";
type Action = {
  member: RosterMember;
  kind: "role" | "remove" | "transfer";
  role?: string;
};
export function People({
  backend,
  org,
  userId,
}: {
  backend: Backend;
  org: Organization;
  userId: string;
}) {
  const cache = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const canManage = org.role === "owner" || org.role === "admin";
  const roster = useQuery({
    queryKey: ["members", org.id],
    queryFn: () => backend.api<RosterMember[]>(`/orgs/${org.id}/members`),
  });
  const invites = useQuery({
    queryKey: ["invitations", org.id],
    queryFn: () => backend.api<Invitation[]>(`/orgs/${org.id}/invitations`),
    enabled: canManage,
    refetchInterval: 15_000,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      backend.api(`/orgs/${org.id}/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      cache.invalidateQueries({ queryKey: ["invitations", org.id] }),
  });
  return (
    <section className="project-content">
      <div className="project-heading">
        <div>
          <div className="eyebrow">{org.name} · WORKSPACE</div>
          <h1>People & teams</h1>
          <p>Keep your club connected through every semester.</p>
        </div>
        {canManage && (
          <button className="primary" onClick={() => setInviteOpen(true)}>
            <Plus size={16} />
            Invite member
          </button>
        )}
      </div>
      {roster.error && <Notice>{message(roster.error)}</Notice>}
      <section className="people-section">
        <h2>
          Members <span>{roster.data?.length ?? 0}</span>
        </h2>
        {roster.isPending && <p role="status">Loading members…</p>}
        {roster.data?.map((member) => (
          <div className="member-row" key={member.id}>
            <span className="avatar">
              {member.display_name.slice(0, 1).toUpperCase()}
            </span>
            <strong>
              {member.display_name}
              {member.user_id === userId && <small> (you)</small>}
            </strong>
            {org.role === "owner" ? (
              <select
                aria-label={`Role for ${member.display_name}`}
                value={member.role}
                onChange={(event) =>
                  setAction({ member, kind: "role", role: event.target.value })
                }
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
            ) : (
              <span className="role-label">{member.role}</span>
            )}
            {org.role === "owner" && member.user_id !== userId && (
              <button
                className="text-button"
                onClick={() => setAction({ member, kind: "transfer" })}
              >
                Transfer ownership
              </button>
            )}
            {(member.user_id === userId ||
              org.role === "owner" ||
              (org.role === "admin" && member.role === "member")) && (
              <button
                className="text-button"
                onClick={() => setAction({ member, kind: "remove" })}
              >
                {member.user_id === userId ? "Leave" : "Remove"}
              </button>
            )}
          </div>
        ))}
      </section>
      <Teams backend={backend} org={org} members={roster.data ?? []} />
      {canManage && (
        <section className="people-section">
          <h2>Invitations</h2>
          <p className="hint">
            Links expire after seven days. If email fails or expires, share your
            saved link or revoke the invitation and create a new one.
          </p>
          {invites.error && <Notice>{message(invites.error)}</Notice>}
          {revoke.error && <Notice>{message(revoke.error)}</Notice>}
          {!invites.data?.length && <p className="hint">No invitations yet.</p>}
          {invites.data?.map((invitation) => (
            <div className="invitation-row" key={invitation.id}>
              <span>{invitation.email}</span>
              <span className="role-label">{invitation.role}</span>
              <small>
                {invitation.accepted_at
                  ? "Accepted"
                  : invitation.revoked_at
                    ? "Revoked"
                    : new Date(invitation.expires_at) < new Date()
                      ? "Expired"
                      : "Pending"}
              </small>
              <small>
                {invitation.email_status === "sent"
                  ? "Email accepted by provider"
                  : invitation.email_status === "queued"
                    ? "Email queued"
                    : invitation.email_status &&
                        invitation.email_status !== "manual"
                      ? `Email ${invitation.email_status}`
                      : "Share link manually"}
              </small>
              {!invitation.accepted_at &&
                !invitation.revoked_at &&
                (org.role === "owner" || invitation.role === "member") && (
                  <button
                    className="text-button"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(invitation.id)}
                  >
                    Revoke
                  </button>
                )}
            </div>
          ))}
        </section>
      )}
      {inviteOpen && (
        <InviteMember
          backend={backend}
          org={org}
          onClose={() => setInviteOpen(false)}
        />
      )}{" "}
      {action && (
        <MemberAction
          backend={backend}
          org={org}
          action={action}
          onClose={() => setAction(null)}
        />
      )}
    </section>
  );
}
function InviteMember({
  backend,
  org,
  onClose,
}: {
  backend: Backend;
  org: Organization;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: (body: { email: string; role: string }) =>
      backend.api<{
        token: string;
        email: string;
        email_status?: Invitation["email_status"];
      }>(`/orgs/${org.id}/invitations`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () =>
      cache.invalidateQueries({ queryKey: ["invitations", org.id] }),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate({
      email: text(event.currentTarget, "email"),
      role: text(event.currentTarget, "role"),
    });
  }
  const link = create.data
    ? `${location.origin}/#invite=${create.data.token}`
    : "";
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <Dialog title="Invite member" onClose={onClose}>
      {create.data ? (
        <div className="invite-result">
          {create.data.email_status === "queued" && (
            <p role="status">
              Invitation email queued. You can also copy the link below.
            </p>
          )}
          <p>
            Share this link with <strong>{create.data.email}</strong>. Only that
            verified email can accept it.
          </p>
          <label>
            Invitation link
            <input
              value={link}
              readOnly
              onFocus={(event) => event.target.select()}
            />
          </label>
          <button onClick={() => void copy()}>
            <Copy size={15} />
            {copied ? "Copied" : "Copy link"}
          </button>
          <p className="hint">
            This link is shown once. You can revoke it from the invitations
            list.
          </p>
        </div>
      ) : (
        <form onSubmit={submit}>
          <label>
            Email
            <input name="email" type="email" required maxLength={254} />
          </label>
          <label>
            Role
            <select name="role" defaultValue="member">
              <option value="member">Member</option>
              {org.role === "owner" && <option value="admin">Admin</option>}
            </select>
          </label>
          {create.error && <Notice>{message(create.error)}</Notice>}
          <footer>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={create.isPending}
            >
              Create invitation
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  );
}
function MemberAction({
  backend,
  org,
  action,
  onClose,
}: {
  backend: Backend;
  org: Organization;
  action: Action;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const sensitive =
    action.kind !== "remove" ||
    action.member.role === "owner" ||
    (action.member.role === "admin" && org.role === "owner");
  const mutate = useMutation({
    mutationFn: async (password: string) => {
      if (sensitive) {
        const { data } = await backend.supabase.auth.getSession();
        const email = data.session?.user.email;
        if (!email) throw new Error("Please sign in again.");
        const verified = await backend.supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (verified.error) throw verified.error;
      }
      if (action.kind === "transfer")
        return backend.api(`/orgs/${org.id}/ownership/transfer`, {
          method: "POST",
          body: JSON.stringify({ membershipId: action.member.id }),
        });
      return backend.api(`/orgs/${org.id}/members/${action.member.id}`, {
        method: action.kind === "remove" ? "DELETE" : "PATCH",
        ...(action.kind === "role"
          ? { body: JSON.stringify({ role: action.role }) }
          : {}),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["organizations"] }),
        cache.invalidateQueries({ queryKey: ["members", org.id] }),
        cache.invalidateQueries({ queryKey: ["teams", org.id] }),
        cache.invalidateQueries({ queryKey: ["projects", org.id] }),
      ]);
      cache.removeQueries({ queryKey: ["issues", org.id] });
      onClose();
    },
  });
  const title =
    action.kind === "transfer"
      ? "Transfer ownership"
      : action.kind === "remove"
        ? "Remove member"
        : "Change role";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutate.mutate(text(event.currentTarget, "password", false));
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <p>
          {action.kind === "transfer"
            ? `${action.member.display_name} will become an owner. Your role will change to Admin.`
            : action.kind === "remove"
              ? `${action.member.display_name} will lose workspace access. Open tasks will be unassigned and project leads handed to an active owner.`
              : `Change ${action.member.display_name} from ${action.member.role} to ${action.role}.`}
        </p>
        {sensitive && (
          <label>
            Confirm your password
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
            />
          </label>
        )}
        {mutate.error && <Notice>{message(mutate.error)}</Notice>}
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={mutate.isPending}>
            Confirm change
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
function Teams({
  backend,
  org,
  members,
}: {
  backend: Backend;
  org: Organization;
  members: RosterMember[];
}) {
  const cache = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Team | null>(null);
  const canManage = org.role !== "member";
  const teams = useQuery({
    queryKey: ["teams", org.id],
    queryFn: () => backend.api<Team[]>(`/orgs/${org.id}/teams`),
  });
  const create = useMutation({
    mutationFn: (name: string) =>
      backend.api(`/orgs/${org.id}/teams`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["teams", org.id] });
      setCreateOpen(false);
    },
  });
  const change = useMutation({
    mutationFn: ({
      teamId,
      memberId,
      add,
    }: {
      teamId: string;
      memberId: string;
      add: boolean;
    }) =>
      backend.api(`/orgs/${org.id}/teams/${teamId}/members/${memberId}`, {
        method: add ? "PUT" : "DELETE",
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["teams", org.id] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      backend.api(`/orgs/${org.id}/teams/${id}`, { method: "DELETE" }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["teams", org.id] }),
  });
  const current = teams.data?.find((t) => t.id === selected?.id);
  const selectedMemberIds = new Set(current?.member_ids ?? []);
  return (
    <section className="people-section">
      <div className="section-heading">
        <h2>Teams</h2>
        {canManage && (
          <button onClick={() => setCreateOpen(true)}>
            <Plus size={14} />
            New team
          </button>
        )}
      </div>
      <p className="hint">
        Teams organize people. All projects remain visible to the whole
        workspace.
      </p>
      {teams.error && <Notice>{message(teams.error)}</Notice>}
      {remove.error && <Notice>{message(remove.error)}</Notice>}
      {!teams.data?.length && (
        <p className="hint">Create a team for a committee or working group.</p>
      )}
      {teams.data?.map((team) => (
        <div className="team-row" key={team.id}>
          <Users size={16} />
          <strong>{team.name}</strong>
          <span>
            {team.member_ids.length}{" "}
            {team.member_ids.length === 1 ? "member" : "members"}
          </span>
          {canManage && (
            <>
              <button className="text-button" onClick={() => setSelected(team)}>
                Manage members
              </button>
            </>
          )}
        </div>
      ))}
      {createOpen && (
        <Dialog title="Create team" onClose={() => setCreateOpen(false)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(text(event.currentTarget, "name"));
            }}
          >
            <label>
              Team name
              <input
                name="name"
                required
                maxLength={100}
                placeholder="Events committee"
              />
            </label>
            {create.error && <Notice>{message(create.error)}</Notice>}
            <footer>
              <button type="button" onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="primary"
                disabled={create.isPending}
              >
                Create team
              </button>
            </footer>
          </form>
        </Dialog>
      )}
      {current && (
        <Dialog
          title={`${current.name} members`}
          onClose={() => setSelected(null)}
        >
          <div className="team-checklist">
            {members.map((member) => (
              <label key={member.id}>
                <input
                  type="checkbox"
                  checked={selectedMemberIds.has(member.id)}
                  disabled={change.isPending}
                  onChange={(event) =>
                    change.mutate({
                      teamId: current.id,
                      memberId: member.id,
                      add: event.target.checked,
                    })
                  }
                />
                {member.display_name}
              </label>
            ))}
          </div>
          {change.error && <Notice>{message(change.error)}</Notice>}
          <button
            className="text-button"
            disabled={remove.isPending}
            onClick={() => {
              remove.mutate(current.id);
              setSelected(null);
            }}
          >
            Delete team (keeps all members and projects)
          </button>
        </Dialog>
      )}
    </section>
  );
}
