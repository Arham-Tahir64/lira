import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { ChevronDown, LayoutGrid, LogOut, Plus, Users } from "lucide-react";
import type { Organization, Project } from "@lira/contracts";
import type { Backend } from "../client";
import { Brand, Notice, Dialog } from "../components/primitives";
import { text, message } from "../form";
import { ProjectView } from "./Project";
export function Workspace({
  backend,
  session,
}: {
  backend: Backend;
  session: Session;
}) {
  const cache = useQueryClient();
  const [orgId, setOrgId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [dialog, setDialog] = useState<"org" | "project" | null>(null);
  const [signoutError, setSignoutError] = useState("");
  const orgs = useQuery({
    queryKey: ["organizations"],
    queryFn: () => backend.api<Organization[]>("/me/organizations"),
  });
  const org = orgs.data?.find((o) => o.id === orgId) ?? orgs.data?.[0];
  const projects = useQuery({
    queryKey: ["projects", org?.id],
    queryFn: () => backend.api<Project[]>(`/orgs/${org!.id}/projects`),
    enabled: !!org,
  });
  const project =
    projects.data?.find((p) => p.id === projectId) ?? projects.data?.[0];
  const canManage = org?.role === "owner" || org?.role === "admin";
  async function signOut() {
    setSignoutError("");
    try {
      await backend.api("/auth/logout", { method: "POST" });
    } catch (err) {
      setSignoutError(message(err));
    } finally {
      const result = await backend.supabase.auth.signOut({ scope: "local" });
      if (result.error) setSignoutError(result.error.message);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-picker">
          <Users size={17} />
          <select
            aria-label="Workspace"
            value={org?.id ?? ""}
            onChange={(event) => {
              setOrgId(event.target.value);
              setProjectId("");
              cache.removeQueries({ queryKey: ["issues"] });
            }}
          >
            {orgs.data?.map((o) => (
              <option value={o.id} key={o.id}>
                {o.name}
              </option>
            ))}
            {!org && <option value="">Your workspace</option>}
          </select>
          <ChevronDown size={14} />
        </div>
        <button className="sidebar-action" onClick={() => setDialog("org")}>
          <Plus size={16} />
          New workspace
        </button>
        <div className="nav-heading">
          <span>Projects</span>
          {canManage && (
            <button
              className="icon-button"
              aria-label="Create project"
              onClick={() => setDialog("project")}
            >
              <Plus size={15} />
            </button>
          )}
        </div>
        <nav aria-label="Projects">
          {projects.data?.map((p) => (
            <button
              key={p.id}
              className={`project-nav ${project?.id === p.id ? "active" : ""}`}
              onClick={() => setProjectId(p.id)}
            >
              <span className="project-mark">{p.key.slice(0, 1)}</span>
              {p.name}
            </button>
          ))}
          {!projects.data?.length && (
            <p className="nav-empty">Your projects will appear here.</p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="avatar">
            {session.user.email?.slice(0, 1).toUpperCase()}
          </span>
          <span className="account-name">{session.user.email}</span>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={() => void signOut()}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="main-workspace">
        <header className="topbar">
          <span>{org?.name ?? "Get started"}</span>
          <span className="separator">/</span>
          <strong>{project?.name ?? "Projects"}</strong>
          <span className="topbar-note">A shared space to get things done</span>
        </header>
        {signoutError && <Notice>{signoutError}</Notice>}
        {orgs.error && <Notice>{message(orgs.error)}</Notice>}
        {projects.error && <Notice>{message(projects.error)}</Notice>}
        {orgs.isPending ? (
          <div className="empty" role="status">
            Loading your workspaces…
          </div>
        ) : !org ? (
          <div className="empty">
            <span className="empty-symbol">
              <Users />
            </span>
            <span className="eyebrow">FIRST THINGS FIRST</span>
            <h1>Make room for your club.</h1>
            <p>Create a workspace to keep your projects and tasks together.</p>
            <button className="primary" onClick={() => setDialog("org")}>
              <Plus size={16} />
              Create workspace
            </button>
          </div>
        ) : projects.isPending ? (
          <div className="empty" role="status">
            Loading projects…
          </div>
        ) : !project ? (
          <div className="empty">
            <span className="empty-symbol">
              <LayoutGrid />
            </span>
            <h1>Your next project starts here.</h1>
            <p>Give your work a home, then break it into tasks.</p>
            {canManage && (
              <button className="primary" onClick={() => setDialog("project")}>
                <Plus size={16} />
                Create project
              </button>
            )}
          </div>
        ) : (
          <ProjectView
            key={`${org.id}:${project.id}`}
            backend={backend}
            org={org}
            project={project}
          />
        )}
      </main>
      {dialog && (
        <CreateContainer
          backend={backend}
          kind={dialog}
          orgId={org?.id}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            if (dialog === "org") {
              setOrgId(id);
              setProjectId("");
            } else setProjectId(id);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
function CreateContainer({
  backend,
  kind,
  orgId,
  onClose,
  onCreated,
}: {
  backend: Backend;
  kind: "org" | "project";
  orgId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      backend.api<{ id: string }>(
        kind === "org" ? "/orgs" : `/orgs/${orgId}/projects`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    onSuccess: async (result) => {
      await cache.invalidateQueries({
        queryKey: kind === "org" ? ["organizations"] : ["projects", orgId],
      });
      onCreated(result.id);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    mutation.mutate(
      kind === "org"
        ? { name: text(form, "name"), slug: text(form, "slug") }
        : {
            name: text(form, "name"),
            key: text(form, "key").toUpperCase(),
            description: text(form, "description"),
          },
    );
  }
  return (
    <Dialog
      title={kind === "org" ? "Create workspace" : "Create project"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label>
          Name
          <input
            name="name"
            required
            maxLength={100}
            placeholder={kind === "org" ? "Your club name" : "Welcome week"}
          />
        </label>
        {kind === "org" ? (
          <label>
            Workspace address
            <input
              name="slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              minLength={3}
              maxLength={48}
              placeholder="your-club"
            />
            <small>Use lowercase letters, numbers, and hyphens.</small>
          </label>
        ) : (
          <>
            <label>
              Project key
              <input
                name="key"
                required
                pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                maxLength={10}
                placeholder="EVENT"
              />
              <small>A short label for task numbers, such as EVENT-1.</small>
            </label>
            <label>
              Description
              <textarea name="description" maxLength={5000} rows={3} />
            </label>
            <p className="hint">Visible to everyone in this workspace.</p>
          </>
        )}
        {mutation.error && <Notice>{message(mutation.error)}</Notice>}
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="primary"
            disabled={mutation.isPending}
          >
            Create {kind === "org" ? "workspace" : "project"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
