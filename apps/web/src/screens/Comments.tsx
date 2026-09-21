import { useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Markdown from "react-markdown";
import type { Comment, Page, RosterMember } from "@lira/contracts";
import type { Backend } from "../client";
import { Notice } from "../components/primitives";
import { message } from "../form";
export function Comments({
  backend,
  orgId,
  issueId,
  projectId,
  archived,
  active,
}: {
  backend: Backend;
  orgId: string;
  issueId: string;
  projectId: string;
  archived: boolean;
  active: boolean;
}) {
  const cache = useQueryClient();
  const key = ["comments", orgId, issueId];
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<Comment | null>(null);
  const [editBody, setEditBody] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const request = useRef<{ body: string; key: string } | null>(null);
  const me = useQuery({
    queryKey: ["me", orgId],
    queryFn: () => backend.api<{ id: string }>("/me"),
  });
  const members = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => backend.api<RosterMember[]>(`/orgs/${orgId}/members`),
  });
  const self = members.data?.find((m) => m.user_id === me.data?.id);
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: active,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      backend.api<Page<Comment>>(
        `/orgs/${orgId}/issues/${issueId}/comments?limit=30${pageParam ? `&after=${pageParam}` : ""}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
  async function refresh() {
    await cache.invalidateQueries({ queryKey: key });
    await cache.invalidateQueries({ queryKey: ["activity", orgId, projectId] });
  }
  const post = useMutation({
    mutationFn: () => {
      if (request.current?.body !== draft)
        request.current = { body: draft, key: crypto.randomUUID() };
      return backend.api(`/orgs/${orgId}/issues/${issueId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: draft, clientKey: request.current.key }),
      });
    },
    onSuccess: async () => {
      setDraft("");
      request.current = null;
      await refresh();
    },
  });
  const change = useMutation({
    mutationFn: ({ comment, remove }: { comment: Comment; remove: boolean }) =>
      backend.api(`/orgs/${orgId}/comments/${comment.id}`, {
        method: remove ? "DELETE" : "PATCH",
        headers: { "If-Match": `"${comment.version}"` },
        ...(remove ? {} : { body: JSON.stringify({ body: editBody }) }),
      }),
    onSuccess: async () => {
      setEditing(null);
      setDeleting(null);
      await refresh();
    },
  });
  return (
    <section aria-label="Task comments" className="comments-panel">
      <h3>Discussion</h3>
      <p className="hint">
        Share updates, decisions, and questions. Markdown is supported.
      </p>
      {query.isPending && <p role="status">Loading comments…</p>}
      {query.error && <Notice>{message(query.error)}</Notice>}
      {change.error && (
        <Notice>
          {message(change.error)} Close the edit and refresh comments before
          retrying a conflict.
        </Notice>
      )}
      <button className="text-button" onClick={() => void query.refetch()}>
        Refresh comments
      </button>
      {query.data?.pages
        .flatMap((p) => p.items)
        .map((c) => (
          <article className="comment" key={c.id}>
            <header>
              <strong>{c.author_name}</strong>
              <time>
                {new Date(c.created_at).toLocaleString()}
                {c.edited_at ? " · edited" : ""}
              </time>
            </header>
            {c.deleted_at ? (
              <p className="hint">Comment removed</p>
            ) : editing?.id === c.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  change.mutate({ comment: editing, remove: false });
                }}
              >
                <label>
                  Edit comment
                  <textarea
                    required
                    maxLength={10000}
                    rows={4}
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                  />
                </label>
                <button type="submit" disabled={change.isPending || archived}>
                  Save comment
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel edit
                </button>
              </form>
            ) : (
              <div className="comment-body">
                <Markdown
                  skipHtml
                  disallowedElements={["img"]}
                  components={{
                    a: ({ children, href }) => (
                      <a href={href} target="_blank" rel="noreferrer noopener">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {c.body}
                </Markdown>
              </div>
            )}
            {!c.deleted_at && !archived && (
              <div className="comment-actions">
                {self?.id === c.author_membership_id && (
                  <button
                    className="text-button"
                    disabled={change.isPending}
                    onClick={() => {
                      setEditing(c);
                      setEditBody(c.body);
                    }}
                  >
                    Edit
                  </button>
                )}
                {self &&
                  (self.id === c.author_membership_id ||
                    self.role !== "member") &&
                  (deleting === c.id ? (
                    <>
                      <button
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate({ comment: c, remove: true })
                        }
                      >
                        Confirm delete
                      </button>
                      <button onClick={() => setDeleting(null)}>Cancel</button>
                    </>
                  ) : (
                    <button
                      className="text-button"
                      onClick={() => setDeleting(c.id)}
                    >
                      Delete
                    </button>
                  ))}
              </div>
            )}
          </article>
        ))}
      {!query.isPending && !query.data?.pages[0]?.items.length && (
        <p className="hint">No comments yet. Start the discussion.</p>
      )}
      {query.hasNextPage && (
        <button
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more comments
        </button>
      )}
      {archived ? (
        <p className="hint">Restore this project to add or change comments.</p>
      ) : (
        <form
          className="comment-composer"
          onSubmit={(e) => {
            e.preventDefault();
            post.mutate();
          }}
        >
          <label>
            Add a comment
            <textarea
              required
              maxLength={10000}
              rows={4}
              value={draft}
              disabled={post.isPending}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What should the team know?"
            />
          </label>
          {post.error && <Notice>{message(post.error)}</Notice>}
          <button
            type="submit"
            className="primary"
            disabled={post.isPending || !draft.trim()}
          >
            Post comment
          </button>
        </form>
      )}
    </section>
  );
}
