import { useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { Issue, IssueStatus, Page, RosterMember } from "@lira/contracts";
import type { Backend } from "../client";
import { Notice } from "../components/primitives";
import { message } from "../form";
const statuses = { todo: "To do", in_progress: "In progress", done: "Done" };
export function BoardColumn({
  backend,
  orgId,
  projectId,
  projectKey,
  planning,
  status,
  filters,
  archived,
  onOpen,
  onCreate,
  dragged,
  onDrag,
}: {
  backend: Backend;
  orgId: string;
  projectId: string;
  projectKey: string;
  planning: string;
  status: IssueStatus;
  filters: string;
  archived: boolean;
  onOpen: (issue: Issue) => void;
  onCreate: (status: IssueStatus) => void;
  dragged: Issue | null;
  onDrag: (issue: Issue | null) => void;
}) {
  const cache = useQueryClient();
  const [announcement, setAnnouncement] = useState("");
  const members = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => backend.api<RosterMember[]>(`/orgs/${orgId}/members`),
  });
  const names = new Map(members.data?.map((m) => [m.id, m.display_name]));
  const query = useInfiniteQuery({
    queryKey: ["issues", orgId, projectId, "column", planning, status, filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      backend.api<Page<Issue>>(
        `/orgs/${orgId}/projects/${projectId}/issues?planningState=${planning}&status=${status}&limit=25&${filters}${pageParam ? `&after=${pageParam}` : ""}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 45000,
  });
  const move = useMutation({
    mutationFn: ({
      issue,
      status,
      beforeId,
      targetPlanning,
    }: {
      issue: Issue;
      status: IssueStatus;
      beforeId: string | null;
      targetPlanning?: string;
    }) =>
      backend.api(`/orgs/${orgId}/issues/${issue.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          status,
          planningState:
            targetPlanning ?? (status === "done" ? "planned" : planning),
          beforeId,
          expectedVersion: issue.version,
        }),
      }),
    onSuccess: (_data, { issue, status, targetPlanning }) =>
      setAnnouncement(
        `${issue.title} moved to ${targetPlanning === "backlog" ? "backlog" : statuses[status]}.`,
      ),
    onSettled: async () => {
      onDrag(null);
      await cache.invalidateQueries({ queryKey: ["issues", orgId, projectId] });
      await cache.invalidateQueries({
        queryKey: ["activity", orgId, projectId],
      });
    },
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const canDrop =
    !!dragged &&
    dragged.project_id === projectId &&
    !archived &&
    !move.isPending &&
    !filters;
  function drop(beforeId: string | null) {
    if (canDrop && dragged && dragged.id !== beforeId)
      move.mutate({ issue: dragged, status, beforeId });
  }
  return (
    <section
      className={`board-column ${canDrop ? "drop-ready" : ""}`}
      aria-label={`${statuses[status]} column`}
      onDragOver={(e) => {
        if (canDrop) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        drop(null);
      }}
    >
      <h2>
        <span className={`status-dot ${status}`} />
        {statuses[status]}{" "}
        <span>
          {items.length}
          {query.hasNextPage ? "+" : ""}
        </span>
      </h2>
      <button
        className="column-add"
        disabled={archived}
        onClick={() => onCreate(status)}
      >
        + Add task to {statuses[status].toLowerCase()}
      </button>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {query.isPending && <p>Loading…</p>}
      {query.error && <Notice>{message(query.error)}</Notice>}
      {move.error && <Notice>{message(move.error)}</Notice>}
      {items.map((issue, index) => (
        <article
          key={issue.id}
          className={`issue-card ${dragged?.id === issue.id ? "dragging" : ""}`}
          onDragOver={(e) => {
            if (canDrop) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            drop(issue.id);
          }}
        >
          <button
            className="drag-handle"
            draggable={!archived && !filters && !move.isPending}
            disabled={archived || !!filters || move.isPending}
            aria-label={`Drag ${issue.title}`}
            title="Drag to a column or before another task. Use Move up/down for keyboard ordering."
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", issue.id);
              onDrag(issue);
            }}
            onDragEnd={() => onDrag(null)}
          >
            ⋮⋮
          </button>
          <button className="card-title" onClick={() => onOpen(issue)}>
            <span className="issue-key">
              {projectKey}-{issue.number}
            </span>
            <h3>{issue.title}</h3>
          </button>
          <div className="card-context">
            <span>
              {issue.assignee_membership_id
                ? (names.get(issue.assignee_membership_id) ?? "Assigned member")
                : "Unassigned"}
            </span>
            {issue.due_date && (
              <time dateTime={issue.due_date}>Due {issue.due_date}</time>
            )}
          </div>
          <div className="card-footer">
            <span className={`priority ${issue.priority}`}>
              {issue.priority}
            </span>
            <select
              aria-label={`Status for ${issue.title}`}
              value={issue.status}
              disabled={archived || move.isPending}
              onChange={(e) =>
                move.mutate({
                  issue,
                  status: e.target.value as IssueStatus,
                  beforeId: null,
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
          <button
            className="text-button"
            aria-label={`Move ${issue.title} up`}
            disabled={archived || move.isPending || index === 0 || !!filters}
            onClick={() =>
              move.mutate({ issue, status, beforeId: items[index - 1]!.id })
            }
          >
            Move up
          </button>
          <button
            className="text-button"
            aria-label={`Move ${issue.title} down`}
            disabled={
              archived ||
              move.isPending ||
              !!filters ||
              index === items.length - 1 ||
              (index >= items.length - 2 && query.hasNextPage)
            }
            onClick={() =>
              move.mutate({
                issue,
                status,
                beforeId: items[index + 2]?.id ?? null,
              })
            }
          >
            Move down
          </button>
          <button
            className="text-button"
            disabled={archived || move.isPending || issue.status === "done"}
            onClick={() =>
              move.mutate({
                issue,
                status,
                beforeId: null,
                targetPlanning: planning === "backlog" ? "planned" : "backlog",
              })
            }
          >
            {planning === "backlog" ? "Plan task" : "Send to backlog"}
          </button>
        </article>
      ))}
      {!query.isPending && !items.length && (
        <p className="hint">No matching tasks</p>
      )}
      {query.hasNextPage && (
        <button
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more {statuses[status].toLowerCase()}
        </button>
      )}
    </section>
  );
}
