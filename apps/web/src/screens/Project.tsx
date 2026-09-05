import { useRef, useState, type FormEvent } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, LayoutGrid, List, Plus, Search, Users } from "lucide-react";
import type {
  Issue,
  IssueStatus,
  Organization,
  Project,
  Page,
} from "@lira/contracts";
import type { Backend } from "../client";
import { Notice, Dialog } from "../components/primitives";
import { text, message } from "../form";
const statuses: Record<IssueStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};
export function ProjectView({
  backend,
  org,
  project,
}: {
  backend: Backend;
  org: Organization;
  project: Project;
}) {
  const [view, setView] = useState<"list" | "board">("list");
  const [planning, setPlanning] = useState<"planned" | "backlog">("planned");
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState(false);
  const [detail, setDetail] = useState<Issue | null>(null);
  const cache = useQueryClient();
  const queryKey = ["issues", org.id, project.id, planning];
  const issues = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      backend.api<Page<Issue>>(
        `/orgs/${org.id}/projects/${project.id}/issues?planningState=${planning}&limit=50${pageParam ? `&after=${pageParam}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 45000,
    refetchIntervalInBackground: false,
  });
  const update = useMutation({
    mutationFn: ({ issue, status }: { issue: Issue; status: IssueStatus }) =>
      backend.api<Issue>(`/orgs/${org.id}/issues/${issue.id}`, {
        method: "PATCH",
        headers: { "If-Match": `"${issue.version}"` },
        body: JSON.stringify({ status }),
      }),
    onSettled: () =>
      cache.invalidateQueries({ queryKey: ["issues", org.id, project.id] }),
  });
  const loaded = issues.data?.pages.flatMap((p) => p.items) ?? [];
  const visible = loaded.filter((i) =>
    `${project.key}-${i.number} ${i.title}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const complete = loaded.filter((i) => i.status === "done").length;
  return (
    <section className="project-content">
      <div className="project-heading">
        <div>
          <div className="eyebrow">{project.key} · PROJECT</div>
          <h1>{project.name}</h1>
          <p>{project.description || "A shared place for the work ahead."}</p>
        </div>
        <button
          className="primary"
          disabled={!!project.archived_at}
          onClick={() => setCreate(true)}
        >
          <Plus size={16} />
          New task
        </button>
      </div>
      <div className="project-meta">
        <span>
          <Users size={14} />
          Workspace visible
        </span>
        <span>
          {complete} of {loaded.length} loaded tasks completed
        </span>
      </div>
      <div className="toolbar">
        <div className="tabs" aria-label="Planning views">
          <button
            className={planning === "planned" ? "selected" : ""}
            onClick={() => setPlanning("planned")}
          >
            Tasks <span>{planning === "planned" ? loaded.length : ""}</span>
          </button>
          <button
            className={planning === "backlog" ? "selected" : ""}
            onClick={() => setPlanning("backlog")}
          >
            Backlog
          </button>
        </div>
        <div className="tools">
          <label className="search">
            <Search size={15} />
            <input
              aria-label="Filter loaded tasks"
              placeholder="Filter loaded tasks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="view-switch">
            <button
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <List size={16} />
            </button>
            <button
              aria-label="Board view"
              aria-pressed={view === "board"}
              onClick={() => setView("board")}
            >
              <LayoutGrid size={16} />
            </button>
          </div>
        </div>
      </div>
      {issues.error && <Notice>{message(issues.error)}</Notice>}
      {update.error && <Notice>{message(update.error)}</Notice>}
      {issues.isPending ? (
        <div className="empty" role="status">
          Loading tasks…
        </div>
      ) : !loaded.length ? (
        <div className="task-empty">
          <span className="empty-symbol">
            <Check />
          </span>
          <h2>A clear space. A fresh start.</h2>
          <p>Add the first task for {project.name}.</p>
          <button onClick={() => setCreate(true)}>
            <Plus size={15} />
            Add a task
          </button>
        </div>
      ) : view === "list" ? (
        <div className="task-list">
          <div className="task-list-header">
            <span>Task</span>
            <span>Status</span>
            <span>Priority</span>
            <span>Due date</span>
          </div>
          {visible.map((issue) => (
            <div className="task-row" key={issue.id}>
              <button className="task-title" onClick={() => setDetail(issue)}>
                <span className={`status-dot ${issue.status}`} />
                <span className="issue-key">
                  {project.key}-{issue.number}
                </span>
                <span>{issue.title}</span>
              </button>
              <select
                aria-label={`Status for ${issue.title}`}
                value={issue.status}
                disabled={update.isPending || !!project.archived_at}
                onChange={(event) =>
                  update.mutate({
                    issue,
                    status: event.target.value as IssueStatus,
                  })
                }
              >
                {Object.entries(statuses).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <span className={`priority ${issue.priority}`}>
                {issue.priority}
              </span>
              <span className="due-date">{issue.due_date ?? "—"}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="board">
          {Object.entries(statuses).map(([status, label]) => (
            <section className="board-column" key={status}>
              <h2>
                <span className={`status-dot ${status}`} />
                {label}
                <span>{visible.filter((i) => i.status === status).length}</span>
              </h2>
              {visible
                .filter((i) => i.status === status)
                .map((issue) => (
                  <article className="task-card" key={issue.id}>
                    <button onClick={() => setDetail(issue)}>
                      <span className="issue-key">
                        {project.key}-{issue.number}
                      </span>
                      <strong>{issue.title}</strong>
                    </button>
                    <div>
                      <span className={`priority ${issue.priority}`}>
                        {issue.priority}
                      </span>
                      <select
                        aria-label={`Status for ${issue.title}`}
                        value={issue.status}
                        disabled={update.isPending || !!project.archived_at}
                        onChange={(event) =>
                          update.mutate({
                            issue,
                            status: event.target.value as IssueStatus,
                          })
                        }
                      >
                        {Object.entries(statuses).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </article>
                ))}
            </section>
          ))}
        </div>
      )}
      {!issues.isPending && loaded.length > 0 && !visible.length && (
        <p className="hint">No loaded tasks match this filter.</p>
      )}
      {issues.hasNextPage && (
        <button
          className="load-more"
          disabled={issues.isFetchingNextPage}
          onClick={() => void issues.fetchNextPage()}
        >
          Load more tasks
        </button>
      )}
      {create && (
        <CreateTask
          backend={backend}
          orgId={org.id}
          projectId={project.id}
          planning={planning}
          onClose={() => setCreate(false)}
        />
      )}{" "}
      {detail && (
        <Dialog
          title={`${project.key}-${detail.number}`}
          onClose={() => setDetail(null)}
        >
          <h3>{detail.title}</h3>
          <p className="task-description">
            {detail.description || "No description yet."}
          </p>
          <p className="hint">
            {statuses[detail.status]} · {detail.priority} priority
          </p>
        </Dialog>
      )}
    </section>
  );
}
function CreateTask({
  backend,
  orgId,
  projectId,
  planning,
  onClose,
}: {
  backend: Backend;
  orgId: string;
  projectId: string;
  planning: string;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const request = useRef<{ body: string; key: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (body: string) => {
      if (request.current?.body !== body)
        request.current = { body, key: crypto.randomUUID() };
      return backend.api(`/orgs/${orgId}/projects/${projectId}/issues`, {
        method: "POST",
        body,
        headers: { "Idempotency-Key": request.current!.key },
      });
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["issues", orgId, projectId] });
      onClose();
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    mutation.mutate(
      JSON.stringify({
        title: text(form, "title"),
        description: text(form, "description"),
        priority: text(form, "priority"),
        dueDate: text(form, "dueDate") || null,
        planningState: planning,
      }),
    );
  }
  return (
    <Dialog title="Create task" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Title
          <input
            name="title"
            required
            maxLength={200}
            placeholder="What needs to happen?"
          />
        </label>
        <label>
          Description
          <textarea
            name="description"
            maxLength={20000}
            rows={4}
            placeholder="Add a little context…"
          />
        </label>
        <div className="form-row">
          <label>
            Priority
            <select name="priority" defaultValue="normal">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label>
            Due date
            <input name="dueDate" type="date" />
          </label>
        </div>
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
            {mutation.isPending ? "Creating…" : "Create task"}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
