import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  Dashboard,
  DashboardTask,
  Page,
  Issue,
  ExportRecord,
} from "@lira/contracts";
import type { Backend } from "../client";
import { Notice } from "../components/primitives";
import { IssueEditor } from "./IssueEditor";
import { message } from "../form";
export function Overview({
  backend,
  orgId,
  canManage,
  onProject,
}: {
  backend: Backend;
  orgId: string;
  canManage: boolean;
  onProject: (id: string) => void;
}) {
  const cache = useQueryClient();
  const [kind, setKind] = useState<"mine" | "overdue">("mine");
  const [detail, setDetail] = useState<Issue | null>(null);
  const summary = useQuery({
    queryKey: ["dashboard", orgId],
    queryFn: () => backend.api<Dashboard>(`/orgs/${orgId}/dashboard`),
    refetchInterval: 30000,
  });
  const tasks = useInfiniteQuery({
    queryKey: ["dashboard-tasks", orgId, kind],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      backend.api<Page<DashboardTask>>(
        `/orgs/${orgId}/dashboard/tasks?kind=${kind}${pageParam ? `&after=${pageParam}` : ""}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 30000,
  });
  const open = useMutation({
    mutationFn: (id: string) =>
      backend.api<Issue>(`/orgs/${orgId}/issues/${id}`),
    onSuccess: setDetail,
  });
  async function refresh() {
    await cache.invalidateQueries({ queryKey: ["dashboard", orgId] });
    await cache.invalidateQueries({ queryKey: ["dashboard-tasks", orgId] });
  }
  return (
    <div className="overview-screen">
      <header className="overview-heading">
        <div>
          <span className="eyebrow">WORKSPACE OVERVIEW</span>
          <h1>What needs your attention?</h1>
          <p>Your tasks and the club’s progress, in one place.</p>
        </div>
        <button onClick={() => void refresh()}>Refresh overview</button>
      </header>
      {summary.error && <Notice>{message(summary.error)}</Notice>}
      {summary.isPending && <p role="status">Loading overview…</p>}
      {summary.data && (
        <>
          <div className="overview-metrics" aria-label="Workspace task counts">
            {(
              [
                ["Assigned to you", summary.data.counts.assigned],
                ["Overdue", summary.data.counts.overdue],
                ["To do", summary.data.counts.todo],
                ["In progress", summary.data.counts.in_progress],
                ["Done", summary.data.counts.done],
              ] as const
            ).map(([label, count]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{count}</strong>
              </div>
            ))}
          </div>
          <p className="hint">
            Active projects only · Includes backlog tasks · Overdue means before{" "}
            {summary.data.today} in the workspace timezone.
          </p>
        </>
      )}
      <div className="overview-columns">
        <section aria-label="Tasks needing attention">
          <div className="tabs inspector-tabs">
            <button
              aria-pressed={kind === "mine"}
              onClick={() => setKind("mine")}
            >
              My tasks
            </button>
            <button
              aria-pressed={kind === "overdue"}
              onClick={() => setKind("overdue")}
            >
              Overdue work
            </button>
          </div>
          {tasks.isPending && <p role="status">Loading tasks…</p>}
          {tasks.error && <Notice>{message(tasks.error)}</Notice>}
          {open.error && <Notice>{message(open.error)}</Notice>}
          {tasks.data?.pages
            .flatMap((p) => p.items)
            .map((task) => (
              <button
                className="overview-task"
                key={task.id}
                disabled={open.isPending}
                onClick={() => open.mutate(task.id)}
              >
                <span>
                  <small>
                    {task.project_key}-{task.number} · {task.project_name}
                  </small>
                  <strong>{task.title}</strong>
                </span>
                <span>
                  {task.due_date ? (
                    <time dateTime={task.due_date}>{task.due_date}</time>
                  ) : (
                    "No due date"
                  )}
                  <small>
                    {
                      {
                        todo: "To do",
                        in_progress: "In progress",
                        done: "Done",
                      }[task.status]
                    }
                    {task.planning_state === "backlog" ? " · backlog" : ""}
                  </small>
                </span>
              </button>
            ))}
          {!tasks.isPending && !tasks.data?.pages[0]?.items.length && (
            <p className="hint">
              {kind === "mine"
                ? "No open tasks assigned to you."
                : "No overdue tasks in active projects."}
            </p>
          )}
          {tasks.hasNextPage && (
            <button
              disabled={tasks.isFetchingNextPage}
              onClick={() => void tasks.fetchNextPage()}
            >
              Load more tasks
            </button>
          )}
        </section>
        <section aria-label="Project progress">
          <h2>Project progress</h2>
          {summary.data?.projects.map((p) => (
            <button
              className="overview-project"
              key={p.id}
              onClick={() => onProject(p.id)}
            >
              <strong>{p.name}</strong>
              {p.term && <small>{p.term}</small>}
              <progress
                value={p.done}
                max={p.total || 1}
                aria-label={`${p.name} completed tasks`}
              />
              <span>
                {p.done} of {p.total} done
                {p.overdue ? ` · ${p.overdue} overdue` : ""}
              </span>
            </button>
          ))}
          {summary.data && !summary.data.projects.length && (
            <p className="hint">Create a project to start tracking progress.</p>
          )}
        </section>
      </div>
      {canManage && <Exports backend={backend} orgId={orgId} />}
      {detail && (
        <IssueEditor
          backend={backend}
          orgId={orgId}
          issue={detail}
          archived={false}
          onClose={() => {
            setDetail(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
function Exports({ backend, orgId }: { backend: Backend; orgId: string }) {
  const cache = useQueryClient();
  const [clientKey, setClientKey] = useState(() => crypto.randomUUID());
  const query = useQuery({
    queryKey: ["exports", orgId],
    queryFn: () =>
      backend.api<{ enabled: boolean; items: ExportRecord[] }>(
        `/orgs/${orgId}/exports`,
      ),
    refetchInterval: 10000,
  });
  const create = useMutation({
    mutationFn: () =>
      backend.api(`/orgs/${orgId}/exports`, {
        method: "POST",
        body: JSON.stringify({ clientKey }),
      }),
    onSuccess: async () => {
      setClientKey(crypto.randomUUID());
      await cache.invalidateQueries({ queryKey: ["exports", orgId] });
    },
  });
  const download = useMutation({
    mutationFn: async (id: string) => {
      const result = await backend.api<{ url: string }>(
        `/orgs/${orgId}/exports/${id}/download`,
        { method: "POST" },
      );
      const a = document.createElement("a");
      a.href = result.url;
      a.rel = "noreferrer noopener";
      a.referrerPolicy = "no-referrer";
      a.download = "lira-export.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
  });
  return (
    <section className="export-panel" aria-label="Workspace export">
      <div>
        <h2>Keep a copy of your club’s work</h2>
        <p>
          Export projects, tasks, comments, teams, labels, activity, and an
          attachment manifest as JSON. File bytes are not included.
        </p>
        <p className="hint">
          Two requests per 24 hours. Downloads expire after 24 hours. Includes
          archived projects. Pilot exports support up to 5 MB; larger exports
          need maintainer assistance.
        </p>
      </div>
      {query.error && <Notice>{message(query.error)}</Notice>}
      {create.error && <Notice>{message(create.error)}</Notice>}
      {download.error && <Notice>{message(download.error)}</Notice>}
      <button
        disabled={create.isPending || !query.data?.enabled}
        onClick={() => create.mutate()}
      >
        {create.isPending ? "Requesting…" : "Request workspace export"}
      </button>
      {query.data && !query.data.enabled && (
        <p className="hint">Export storage has not been configured.</p>
      )}
      {query.data?.items.map((item) => (
        <div className="export-row" key={item.id}>
          <span>
            {new Date(item.created_at).toLocaleString()} · {item.state}
            {item.failure ? ` · ${item.failure}` : ""}
          </span>
          {item.state === "ready" && (
            <button
              disabled={download.isPending}
              onClick={() => download.mutate(item.id)}
            >
              Download export
            </button>
          )}
          {item.state === "pending" && (
            <span className="hint">Waiting for the worker</span>
          )}
        </div>
      ))}
    </section>
  );
}
