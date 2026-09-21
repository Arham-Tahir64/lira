import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Backend } from "../client";
import { Notice } from "../components/primitives";
import { message } from "../form";
interface Notification {
  id: string;
  project_id: string;
  issue_id: string;
  title: string;
  number: number;
  project_key: string;
  read_at: string | null;
  created_at: string;
}
interface Page {
  items: Notification[];
  nextCursor: string | null;
}
export function Notifications({
  backend,
  orgId,
  userId,
  onProject,
}: {
  backend: Backend;
  orgId: string;
  userId: string;
  onProject: (id: string) => void;
}) {
  const [unread, setUnread] = useState(false);
  const cache = useQueryClient();
  const key = ["notifications", orgId, userId];
  const inbox = useInfiniteQuery({
    queryKey: [...key, unread],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      backend.api<Page>(
        `/orgs/${orgId}/notifications?unread=${unread}&limit=30${pageParam ? `&after=${pageParam}` : ""}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
  const preferences = useQuery({
    queryKey: ["notification-preferences", orgId, userId],
    queryFn: () =>
      backend.api<{ assignmentEmail: boolean; emailAvailable: boolean }>(
        `/orgs/${orgId}/notification-preferences`,
      ),
  });
  const mark = useMutation({
    mutationFn: ({ id, read }: { id: string; read: boolean }) =>
      backend.api(`/orgs/${orgId}/notifications/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ read }),
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: key }),
  });
  const preference = useMutation({
    mutationFn: (assignmentEmail: boolean) =>
      backend.api(`/orgs/${orgId}/notification-preferences`, {
        method: "PUT",
        body: JSON.stringify({ assignmentEmail }),
      }),
    onSuccess: () =>
      cache.invalidateQueries({
        queryKey: ["notification-preferences", orgId, userId],
      }),
  });
  const items = inbox.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="project-content">
      <div className="eyebrow">YOUR WORKSPACE INBOX</div>
      <h1>Notifications</h1>
      <p>Task assignments from your club.</p>
      <div className="notification-controls">
        <label>
          <input
            type="checkbox"
            checked={unread}
            onChange={(e) => setUnread(e.target.checked)}
          />{" "}
          Unread only
        </label>
        {preferences.data && (
          <label>
            <input
              type="checkbox"
              checked={preferences.data.assignmentEmail}
              disabled={
                preference.isPending ||
                (!preferences.data.emailAvailable &&
                  !preferences.data.assignmentEmail)
              }
              onChange={(e) => preference.mutate(e.target.checked)}
            />{" "}
            Email me about assignments{" "}
            {!preferences.data.emailAvailable && (
              <span className="hint">· coming soon</span>
            )}
          </label>
        )}
      </div>
      {inbox.error && <Notice>{message(inbox.error)}</Notice>}
      {mark.error && <Notice>{message(mark.error)}</Notice>}
      {preferences.error && <Notice>{message(preferences.error)}</Notice>}
      {preference.error && <Notice>{message(preference.error)}</Notice>}
      {inbox.isPending ? (
        <p role="status">Loading notifications…</p>
      ) : !items.length ? (
        <p className="task-empty">
          {unread
            ? "No unread notifications."
            : "New assignments will appear here."}
        </p>
      ) : (
        items.map((n) => (
          <article
            key={n.id}
            className={`notification-row ${n.read_at ? "" : "unread"}`}
          >
            <div>
              <span className="issue-key">
                {n.project_key}-{n.number}
              </span>
              <strong>{n.title}</strong>
              <p className="hint">
                Assigned to you · {new Date(n.created_at).toLocaleString()}
              </p>
            </div>
            <button onClick={() => onProject(n.project_id)}>
              Open project
            </button>
            <button
              className="text-button"
              disabled={mark.isPending}
              onClick={() => mark.mutate({ id: n.id, read: !n.read_at })}
            >
              {n.read_at ? "Mark unread" : "Mark read"}
            </button>
          </article>
        ))
      )}
      {inbox.hasNextPage && (
        <button
          disabled={inbox.isFetchingNextPage}
          onClick={() => void inbox.fetchNextPage()}
        >
          Load older notifications
        </button>
      )}
    </section>
  );
}
