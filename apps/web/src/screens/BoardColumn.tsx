import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { Issue, IssueStatus, Page } from "@lira/contracts";
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
}) {
  const cache = useQueryClient();
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
    }: {
      issue: Issue;
      status: IssueStatus;
      beforeId: string | null;
    }) =>
      backend.api(`/orgs/${orgId}/issues/${issue.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          status,
          planningState: status === "done" ? "planned" : planning,
          beforeId,
          expectedVersion: issue.version,
        }),
      }),
    onSettled: async () => {
      await cache.invalidateQueries({ queryKey: ["issues", orgId, projectId] });
      await cache.invalidateQueries({
        queryKey: ["activity", orgId, projectId],
      });
    },
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="board-column">
      <h2>
        <span className={`status-dot ${status}`} />
        {statuses[status]}{" "}
        <span>
          {items.length}
          {query.hasNextPage ? "+" : ""}
        </span>
      </h2>
      {query.isPending && <p>Loading…</p>}
      {query.error && <Notice>{message(query.error)}</Notice>}
      {move.error && <Notice>{message(move.error)}</Notice>}
      {items.map((issue, index) => (
        <article key={issue.id} className="issue-card">
          <button onClick={() => onOpen(issue)}>
            <span className="issue-key">
              {projectKey}-{issue.number}
            </span>
            <h3>{issue.title}</h3>
          </button>
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
