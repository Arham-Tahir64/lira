import { useRef, useState, type FormEvent } from "react";
import {
  useInfiniteQuery,
  useQuery,
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
  Label,
  RosterMember,
} from "@lira/contracts";
import type { Backend } from "../client";
import { Notice, Dialog } from "../components/primitives";
import { text, message } from "../form";
import { IssueEditor } from "./IssueEditor";
import { BoardColumn } from "./BoardColumn";
import { ProjectActivity } from "./ProjectActivity";
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
  const [view, setView] = useState<"list" | "board" | "activity">("board");
  const [planning, setPlanning] = useState<"planned" | "backlog">("planned");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState("");
  const [label, setLabel] = useState("");
  const [dueBefore, setDueBefore] = useState("");
  const filters = new URLSearchParams(
    Object.fromEntries(
      Object.entries({
        q: submittedSearch,
        assignee,
        priority,
        label,
        dueBefore,
      }).filter(([, v]) => v),
    ),
  ).toString();
  const labels = useQuery({
    queryKey: ["labels", org.id],
    queryFn: () => backend.api<Label[]>(`/orgs/${org.id}/labels`),
  });
  const members = useQuery({
    queryKey: ["members", org.id],
    queryFn: () => backend.api<RosterMember[]>(`/orgs/${org.id}/members`),
  });
  const [create, setCreate] = useState(false);
  const [createStatus, setCreateStatus] = useState<IssueStatus>("todo");
  const [dragged, setDragged] = useState<Issue | null>(null);
  const [detail, setDetail] = useState<Issue | null>(null);
  const cache = useQueryClient();
  const queryKey = ["issues", org.id, project.id, planning, filters];
  const issues = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      backend.api<Page<Issue>>(
        `/orgs/${org.id}/projects/${project.id}/issues?planningState=${planning}&limit=50&${filters}${pageParam ? `&after=${pageParam}` : ""}`,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: view === "list",
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
  const archive = useMutation({
    mutationFn: () =>
      backend.api(
        `/orgs/${org.id}/projects/${project.id}/${project.archived_at ? "unarchive" : "archive"}`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ["projects", org.id] });
      await cache.invalidateQueries({
        queryKey: ["activity", org.id, project.id],
      });
    },
  });
  const me = useQuery({
    queryKey: ["me", org.id],
    queryFn: () => backend.api<{ id: string }>("/me"),
  });
  const canArchive =
    org.role !== "member" ||
    members.data?.some(
      (m) => m.id === project.lead_membership_id && m.user_id === me.data?.id,
    );
  const loaded = issues.data?.pages.flatMap((p) => p.items) ?? [];
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
          onClick={() => {
            setCreateStatus("todo");
            setCreate(true);
          }}
        >
          <Plus size={16} />
          New task
        </button>
      </div>
      {project.archived_at && (
        <p className="hint">Archived project · tasks are read-only</p>
      )}
      {canArchive && (
        <button
          className="text-button"
          disabled={archive.isPending}
          onClick={() => archive.mutate()}
        >
          {project.archived_at ? "Restore project" : "Archive project"}
        </button>
      )}
      {archive.error && <Notice>{message(archive.error)}</Notice>}
      <div className="project-meta">
        <span>
          <Users size={14} />
          Workspace visible
        </span>
        {view === "list" && (
          <span>
            {complete} of {loaded.length} loaded tasks completed
          </span>
        )}
      </div>
      <div className="toolbar">
        <div className="tabs" aria-label="Planning views">
          <button
            className={planning === "planned" ? "selected" : ""}
            onClick={() => setPlanning("planned")}
          >
            Tasks{" "}
            <span>
              {planning === "planned" && view === "list" ? loaded.length : ""}
            </span>
          </button>
          <button
            className={planning === "backlog" ? "selected" : ""}
            onClick={() => setPlanning("backlog")}
          >
            Backlog
          </button>
        </div>
        <div className="tools">
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmittedSearch(search);
            }}
          >
            <Search size={15} />
            <input
              aria-label="Search project tasks"
              placeholder="Search project tasks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button type="submit">Search</button>
          </form>
          <div className="view-switch">
            <button
              aria-pressed={view === "activity"}
              onClick={() => setView("activity")}
            >
              Activity
            </button>
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
      <div className="filter-row">
        <label>
          Assignee
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">All members</option>
            {members.data
              ?.filter((m) => m.state === "active")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Priority
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            <option value="">All priorities</option>
            {["low", "normal", "high", "urgent"].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Label
          <select value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="">All labels</option>
            {labels.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due on or before
          <input
            type="date"
            value={dueBefore}
            onChange={(e) => setDueBefore(e.target.value)}
          />
        </label>
      </div>
      {view === "board" && (
        <p className="hint">
          {filters
            ? "Clear filters to drag or reorder tasks. Status and planning controls remain available."
            : "Drag a handle to another column or before a task. Move up/down and status controls work with the keyboard."}
        </p>
      )}
      {filters && (
        <button
          className="text-button"
          onClick={() => {
            setSearch("");
            setSubmittedSearch("");
            setAssignee("");
            setPriority("");
            setLabel("");
            setDueBefore("");
          }}
        >
          Clear filters
        </button>
      )}
      {issues.error && <Notice>{message(issues.error)}</Notice>}
      {update.error && <Notice>{message(update.error)}</Notice>}
      {view === "activity" ? (
        <ProjectActivity
          backend={backend}
          orgId={org.id}
          projectId={project.id}
        />
      ) : view === "board" ? (
        <div className="board">
          {(Object.keys(statuses) as IssueStatus[]).map((status) => (
            <BoardColumn
              key={status}
              backend={backend}
              orgId={org.id}
              projectId={project.id}
              projectKey={project.key}
              planning={planning}
              status={status}
              filters={filters}
              archived={!!project.archived_at}
              onOpen={setDetail}
              onCreate={(status) => {
                setCreateStatus(status);
                setCreate(true);
              }}
              dragged={dragged}
              onDrag={setDragged}
            />
          ))}
        </div>
      ) : issues.isPending ? (
        <div className="empty" role="status">
          Loading tasks…
        </div>
      ) : !loaded.length ? (
        <div className="task-empty">
          <span className="empty-symbol">
            <Check />
          </span>
          <h2>No matching tasks</h2>
          <p>Try another search or add a task to {project.name}.</p>
          <button
            disabled={!!project.archived_at}
            onClick={() => {
              setCreateStatus("todo");
              setCreate(true);
            }}
          >
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
          {loaded.map((issue) => (
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
      ) : null}
      {view === "list" && issues.hasNextPage && (
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
          planning={createStatus === "done" ? "planned" : planning}
          initialStatus={createStatus}
          onClose={() => setCreate(false)}
        />
      )}{" "}
      {detail && (
        <IssueEditor
          backend={backend}
          orgId={org.id}
          issue={detail}
          archived={!!project.archived_at}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  );
}
function CreateTask({
  backend,
  orgId,
  projectId,
  planning,
  initialStatus,
  onClose,
}: {
  backend: Backend;
  orgId: string;
  projectId: string;
  planning: string;
  initialStatus: IssueStatus;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const members = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => backend.api<RosterMember[]>(`/orgs/${orgId}/members`),
  });
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
        status: initialStatus,
        assigneeMembershipId: text(form, "assignee") || null,
      }),
    );
  }
  return (
    <Dialog title="Create task" onClose={onClose}>
      <p className="hint">
        {statuses[initialStatus]} ·{" "}
        {planning === "backlog" ? "Backlog" : "Planned work"}
      </p>
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
        <label>
          Assignee
          <select
            name="assignee"
            defaultValue=""
            disabled={members.isPending || !!members.error}
          >
            <option value="">Unassigned</option>
            {members.data
              ?.filter((m) => m.state === "active")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
          </select>
        </label>
        {members.error && <Notice>{message(members.error)}</Notice>}
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
