import { useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Attachment, AttachmentList, RosterMember } from "@lira/contracts";
import type { Backend } from "../client";
import { Notice } from "../components/primitives";
import { message } from "../form";
const types: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
};
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
export function Attachments({
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
  const key = ["attachments", orgId, issueId];
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef<{
    file: File;
    key: string;
    id?: string;
    uploaded?: boolean;
  }>(null);
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
      backend.api<AttachmentList>(
        `/orgs/${orgId}/issues/${issueId}/attachments${pageParam ? `?after=${pageParam}` : ""}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 5000,
  });
  async function refresh() {
    await cache.invalidateQueries({ queryKey: ["attachments", orgId] });
    await cache.invalidateQueries({ queryKey: ["activity", orgId, projectId] });
  }
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a file first.");
      const mediaType = types[file.name.split(".").pop()?.toLowerCase() ?? ""];
      if (!mediaType || file.size < 1 || file.size > 10485760)
        throw new Error(
          "Choose a PDF, PNG, JPEG, or text file between 1 byte and 10 MB.",
        );
      if (attempt.current?.file !== file)
        attempt.current = { file, key: crypto.randomUUID() };
      const request = attempt.current;
      if (!request.uploaded) {
        setPhase("Preparing upload…");
        const checksum = Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
          ),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        const reservation = await backend.api<{
          id: string;
          uploadUrl: string;
        }>(`/orgs/${orgId}/issues/${issueId}/attachments`, {
          method: "POST",
          body: JSON.stringify({
            name: file.name,
            mediaType,
            bytes: file.size,
            checksum,
            clientKey: request.key,
          }),
        });
        request.id = reservation.id;
        setPhase("Uploading file…");
        // Signed capability only; never forward the user's API bearer token to storage.
        const response = await fetch(reservation.uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": mediaType, "Cache-Control": "max-age=0" },
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(120000),
        });
        // A lost successful response leaves an immutable object. Completion validates its exact checksum.
        if (!response.ok) {
          const failure = (await response.json().catch(() => ({}))) as {
            error?: string;
            statusCode?: string;
          };
          const duplicate =
            [400, 409].includes(response.status) &&
            (failure.error === "Duplicate" || failure.statusCode === "409");
          if (!duplicate)
            throw new Error(
              "Upload failed. Retry the same file or remove the pending upload.",
            );
        }
        request.uploaded = true;
      }
      setPhase("Submitting file for validation…");
      await backend.api(`/orgs/${orgId}/attachments/${request.id}/complete`, {
        method: "POST",
      });
    },
    onSuccess: async () => {
      setFile(null);
      attempt.current = null;
      if (input.current) input.current.value = "";
      setPhase("Upload submitted for validation.");
      await refresh();
    },
    onError: async () => {
      setPhase("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      backend.api(`/orgs/${orgId}/attachments/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
  });
  const download = useMutation({
    mutationFn: async (a: Attachment) => {
      const result = await backend.api<{ url: string }>(
        `/orgs/${orgId}/attachments/${a.id}/download`,
        { method: "POST" },
      );
      const link = document.createElement("a");
      link.href = result.url;
      link.rel = "noreferrer noopener";
      link.referrerPolicy = "no-referrer";
      link.download = a.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    },
  });
  const info = query.data?.pages[0];
  return (
    <section aria-label="Task attachments" className="attachments-panel">
      <h3>Attachments</h3>
      <p className="hint">PDF, PNG, JPEG, or plain text · Up to 10 MB each</p>
      {info && (
        <p className="hint">
          Workspace storage: {size(info.usedBytes)} of {size(info.quotaBytes)}{" "}
          used or reserved. Pending uploads reserve 10 MB until validated or
          cleaned up.
        </p>
      )}
      {query.isPending && <p role="status">Loading attachments…</p>}
      {query.error && <Notice>{message(query.error)}</Notice>}
      {upload.error && <Notice>{message(upload.error)}</Notice>}
      {remove.error && <Notice>{message(remove.error)}</Notice>}
      {download.error && <Notice>{message(download.error)}</Notice>}
      <button className="text-button" onClick={() => void query.refetch()}>
        Refresh attachments
      </button>
      {query.data?.pages
        .flatMap((p) => p.items)
        .map((a) => (
          <article className="attachment-row" key={a.id}>
            <div>
              <strong>{a.name}</strong>
              <p className="hint">
                {size(a.bytes)} ·{" "}
                {a.state === "quarantined"
                  ? "Validating"
                  : a.state === "pending"
                    ? "Upload pending"
                    : a.state === "deleting"
                      ? "Removed · cleanup pending"
                      : "Ready"}
                {a.rejection ? ` · ${a.rejection}` : ""}
              </p>
            </div>
            {a.state === "ready" && (
              <button
                disabled={download.isPending}
                onClick={() => download.mutate(a)}
              >
                Download
              </button>
            )}
            {!archived &&
              a.state !== "deleting" &&
              self &&
              (self.id === a.uploader_membership_id ||
                self.role !== "member") &&
              (deleting === a.id ? (
                <>
                  <button
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(a.id)}
                  >
                    Confirm remove
                  </button>
                  <button onClick={() => setDeleting(null)}>Cancel</button>
                </>
              ) : (
                <button
                  disabled={upload.isPending}
                  onClick={() => setDeleting(a.id)}
                >
                  Remove
                </button>
              ))}
          </article>
        ))}
      {info && !info.items.length && (
        <p className="hint">No attachments yet.</p>
      )}
      {query.hasNextPage && (
        <button
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more attachments
        </button>
      )}
      {archived ? (
        <p className="hint">Restore this project to upload or remove files.</p>
      ) : info?.uploadEnabled ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            upload.mutate();
          }}
        >
          <label>
            Choose attachment
            <input
              ref={input}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.txt"
              disabled={upload.isPending}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                attempt.current = null;
                setPhase("");
                upload.reset();
              }}
            />
          </label>
          <button
            type="submit"
            className="primary"
            disabled={!file || upload.isPending}
          >
            {upload.isPending ? "Uploading…" : "Upload attachment"}
          </button>
        </form>
      ) : (
        <p className="hint">Uploads are not enabled for this workspace.</p>
      )}
      <p role="status">{phase}</p>
    </section>
  );
}
