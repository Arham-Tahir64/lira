import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Activity, Page, RosterMember, Label } from "@lira/contracts";
import type { Backend } from "../client";
import { Notice } from "../components/primitives";
import { message } from "../form";
export function ProjectActivity({
  backend,
  orgId,
  projectId,
}: {
  backend: Backend;
  orgId: string;
  projectId: string;
}) {
  const query = useInfiniteQuery({
    queryKey: ["activity", orgId, projectId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      backend.api<Page<Activity>>(
        `/orgs/${orgId}/projects/${projectId}/activity?limit=30${pageParam ? `&after=${pageParam}` : ""}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const members = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => backend.api<RosterMember[]>(`/orgs/${orgId}/members`),
  });
  const labels = useQuery({
    queryKey: ["labels", orgId],
    queryFn: () => backend.api<Label[]>(`/orgs/${orgId}/labels`),
  });
  const memberNames = new Map(members.data?.map((m) => [m.id, m.display_name]));
  const labelNames = new Map(labels.data?.map((l) => [l.id, l.name]));
  function display(field: string, value: unknown): string {
    if (value == null) return "none";
    if (field === "assignee_membership_id")
      return memberNames.get(String(value)) ?? "Former member";
    if (field === "labels" && Array.isArray(value))
      return (
        value
          .map((id) => labelNames.get(String(id)) ?? "Removed label")
          .join(", ") || "none"
      );
    return String(value).replaceAll("_", " ");
  }
  function change(field: string, value: unknown): string {
    if (typeof value === "object" && value !== null) {
      if ("changed" in value) return "updated";
      if ("before" in value && "after" in value)
        return `${display(field, value.before)} → ${display(field, value.after)}`;
    }
    if (field === "beforeId")
      return value ? "reordered before another task" : "moved to end";
    return display(field, value);
  }
  return (
    <section aria-label="Project activity">
      <h2>Activity</h2>
      {query.isPending && <p>Loading activity…</p>}
      {query.error && <Notice>{message(query.error)}</Notice>}
      {query.data?.pages
        .flatMap((p) => p.items)
        .map((event) => (
          <article key={event.id} className="activity-row">
            <strong>{event.actor_name}</strong> ·{" "}
            {event.action.replaceAll(".", " ").replaceAll("_", " ")}{" "}
            {event.issue_number ? `#${event.issue_number}` : ""}
            <time>{new Date(event.created_at).toLocaleString()}</time>
            {Object.entries(event.changes).map(([field, value]) => (
              <div className="hint" key={field}>
                {field === "assignee_membership_id"
                  ? "Assignee"
                  : field.replaceAll("_", " ")}
                : {change(field, value)}
              </div>
            ))}
          </article>
        ))}
      {query.hasNextPage && (
        <button
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load older activity
        </button>
      )}
    </section>
  );
}
