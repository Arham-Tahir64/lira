import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, Label, RosterMember, UpdateIssue } from "@lira/contracts";
import type { Backend } from "../client";
import { Dialog, Notice } from "../components/primitives";
import { Comments } from "./Comments";
import { message, text } from "../form";
export function IssueEditor({
  backend,
  orgId,
  issue,
  archived,
  onClose,
}: {
  backend: Backend;
  orgId: string;
  issue: Issue;
  archived: boolean;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [tab, setTab] = useState<"details" | "discussion">("details");
  const [version, setVersion] = useState(issue.version);
  const [labelName, setLabelName] = useState("");
  const members = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => backend.api<RosterMember[]>(`/orgs/${orgId}/members`),
  });
  const labels = useQuery({
    queryKey: ["labels", orgId],
    queryFn: () => backend.api<Label[]>(`/orgs/${orgId}/labels`),
  });
  const selected = useQuery({
    queryKey: ["issue-labels", orgId, issue.id],
    queryFn: () =>
      backend.api<Label[]>(`/orgs/${orgId}/issues/${issue.id}/labels`),
  });
  const save = useMutation({
    mutationFn: (input: UpdateIssue) =>
      backend.api<Issue>(`/orgs/${orgId}/issues/${issue.id}`, {
        method: "PATCH",
        headers: { "If-Match": `"${version}"` },
        body: JSON.stringify(input),
      }),
    onError: () =>
      cache.invalidateQueries({
        queryKey: ["issues", orgId, issue.project_id],
      }),
    onSuccess: async (result) => {
      setVersion(result.version);
      await cache.invalidateQueries({
        queryKey: ["issues", orgId, issue.project_id],
      });
      await cache.invalidateQueries({
        queryKey: ["activity", orgId, issue.project_id],
      });
      await cache.invalidateQueries({
        queryKey: ["issue-labels", orgId, issue.id],
      });
      onClose();
    },
  });
  const createLabel = useMutation({
    mutationFn: () =>
      backend.api(`/orgs/${orgId}/labels`, {
        method: "POST",
        body: JSON.stringify({ name: labelName }),
      }),
    onSuccess: async () => {
      setLabelName("");
      await cache.invalidateQueries({ queryKey: ["labels", orgId] });
    },
  });
  if (members.isPending || labels.isPending || selected.isPending)
    return (
      <Dialog title="Loading task details" onClose={onClose}>
        <p role="status">Loading…</p>
      </Dialog>
    );
  if (
    (!members.data && members.error) ||
    (!labels.data && labels.error) ||
    (!selected.data && selected.error)
  )
    return (
      <Dialog title="Task details unavailable" onClose={onClose}>
        <Notice>
          {message(members.error || labels.error || selected.error)}
        </Notice>
        <button
          onClick={() => {
            void members.refetch();
            void labels.refetch();
            void selected.refetch();
          }}
        >
          Retry
        </button>
      </Dialog>
    );
  const selectedIds = new Set(selected.data?.map((l) => l.id));
  return (
    <Dialog
      className="issue-editor"
      title={`Edit task #${issue.number}`}
      onClose={onClose}
    >
      <div className="tabs inspector-tabs">
        <button
          aria-pressed={tab === "details"}
          onClick={() => setTab("details")}
        >
          Details
        </button>
        <button
          aria-pressed={tab === "discussion"}
          onClick={() => setTab("discussion")}
        >
          Discussion
        </button>
      </div>
      <div hidden={tab !== "details"}>
        {archived && (
          <p className="hint">
            This project is archived. Restore it to edit tasks.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            save.mutate({
              title: text(form, "title"),
              description: text(form, "description"),
              priority: text(form, "priority") as UpdateIssue["priority"],
              status: text(form, "status") as UpdateIssue["status"],
              planningState: text(
                form,
                "planning",
              ) as UpdateIssue["planningState"],
              assigneeMembershipId: text(form, "assignee") || null,
              dueDate: text(form, "dueDate") || null,
              labelIds: new FormData(form).getAll("label").map(String),
            });
          }}
        >
          <fieldset
            disabled={archived || save.isPending}
            className="editor-fields"
          >
            <label>
              Title
              <input
                name="title"
                defaultValue={issue.title}
                required
                maxLength={200}
              />
            </label>
            <label>
              Description
              <textarea
                name="description"
                defaultValue={issue.description}
                maxLength={20000}
                rows={3}
              />
            </label>
            <div className="form-row">
              <label>
                Status
                <select name="status" defaultValue={issue.status}>
                  <option value="todo">To do</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                </select>
              </label>
              <label>
                Planning
                <select name="planning" defaultValue={issue.planning_state}>
                  <option value="planned">Planned</option>
                  <option value="backlog">Backlog</option>
                </select>
              </label>
            </div>
            <div className="form-row">
              <label>
                Priority
                <select name="priority" defaultValue={issue.priority}>
                  {["low", "normal", "high", "urgent"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label>
                Due date
                <input
                  type="date"
                  name="dueDate"
                  defaultValue={issue.due_date ?? ""}
                />
              </label>
            </div>
            <label>
              Assignee
              <select
                name="assignee"
                defaultValue={issue.assignee_membership_id ?? ""}
                disabled={members.isPending || !!members.error}
              >
                <option value="">Unassigned</option>
                {members.data
                  ?.filter(
                    (m) =>
                      m.state === "active" ||
                      m.id === issue.assignee_membership_id,
                  )
                  .map((m) => (
                    <option
                      key={m.id}
                      value={m.id}
                      disabled={m.state !== "active"}
                    >
                      {m.display_name}
                      {m.state !== "active" ? " (inactive)" : ""}
                    </option>
                  ))}
              </select>
            </label>
            <fieldset className="label-options">
              <legend>Labels</legend>
              {selected.isPending ? (
                <p>Loading labels…</p>
              ) : (
                labels.data?.map((l) => (
                  <label key={l.id}>
                    <input
                      name="label"
                      type="checkbox"
                      value={l.id}
                      defaultChecked={selectedIds.has(l.id)}
                    />
                    {l.name}
                  </label>
                ))
              )}
            </fieldset>
          </fieldset>
          {save.error && <Notice>{message(save.error)}</Notice>}
          {(members.error || labels.error || selected.error) && (
            <Notice>
              Some task options could not refresh. Your draft is still here.{" "}
              <button
                type="button"
                onClick={() => {
                  void members.refetch();
                  void labels.refetch();
                  void selected.refetch();
                }}
              >
                Retry loading options
              </button>
            </Notice>
          )}
          {save.error && (
            <p className="hint">
              If another member changed this task, close and reopen it to load
              the latest version. Your draft is still here.
            </p>
          )}
          <footer>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                archived ||
                save.isPending ||
                members.isPending ||
                labels.isPending ||
                selected.isPending ||
                !!members.error ||
                !!labels.error ||
                !!selected.error
              }
            >
              Save changes
            </button>
          </footer>
        </form>
        {!archived && (
          <form
            className="new-label"
            onSubmit={(e) => {
              e.preventDefault();
              createLabel.mutate();
            }}
          >
            <label>
              New workspace label
              <input
                value={labelName}
                onChange={(e) => setLabelName(e.target.value)}
                required
                maxLength={40}
              />
            </label>
            <button type="submit" disabled={createLabel.isPending}>
              Create label
            </button>
            {createLabel.error && <Notice>{message(createLabel.error)}</Notice>}
          </form>
        )}
      </div>
      <div hidden={tab !== "discussion"}>
        <Comments
          backend={backend}
          orgId={orgId}
          active={tab === "discussion"}
          issueId={issue.id}
          projectId={issue.project_id}
          archived={archived}
        />
      </div>
    </Dialog>
  );
}
