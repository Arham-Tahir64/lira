import { createHash } from "node:crypto";
import type { Transaction } from "./database.js";
import type {
  CreateIssue,
  UpdateIssue,
  Issue,
  Membership,
} from "@lira/contracts";
import { Problem } from "./problem.js";
const fields =
  "id,project_id,number,title,description,status,planning_state,priority,assignee_membership_id,to_char(due_date,'YYYY-MM-DD') AS due_date,version,created_at,updated_at";
export async function projectAccess(
  tx: Transaction,
  orgId: string,
  projectId: string,
  write = false,
) {
  const result = await tx.query(
    "SELECT id,key,archived_at FROM app.projects WHERE org_id=$1 AND id=$2 FOR SHARE",
    [orgId, projectId],
  );
  const project = result.rows[0];
  if (!project) throw new Problem(404, "not_found", "Project not found.");
  if (write && project.archived_at)
    throw new Problem(409, "project_archived", "This project is archived.");
  return project as { id: string; key: string; archived_at: Date | null };
}
async function assigneeAccess(
  tx: Transaction,
  orgId: string,
  assignee: string | null | undefined,
) {
  if (!assignee) return;
  const result = await tx.query(
    "SELECT id FROM app.memberships WHERE org_id=$1 AND id=$2 AND state='active'",
    [orgId, assignee],
  );
  if (!result.rowCount)
    throw new Problem(
      400,
      "invalid_assignee",
      "Choose an active workspace member.",
    );
}
async function record(
  tx: Transaction,
  orgId: string,
  issue: Issue,
  member: Membership,
  action: string,
  changes: unknown,
) {
  const { rows } = await tx.query(
    "INSERT INTO app.activity_events(org_id,project_id,issue_id,actor_membership_id,action,changes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
    [
      orgId,
      issue.project_id,
      issue.id,
      member.id,
      action,
      JSON.stringify(changes),
    ],
  );
  await tx.query(
    "INSERT INTO app.outbox_jobs(org_id,event_id,type,payload) VALUES($1,$2,$3,$4)",
    [
      orgId,
      rows[0].id,
      action,
      JSON.stringify({ issueId: issue.id, projectId: issue.project_id }),
    ],
  );
}
export async function createIssue(
  tx: Transaction,
  orgId: string,
  projectId: string,
  member: Membership,
  input: CreateIssue,
  key: string,
) {
  // Serialize idempotency before taking the project counter lock; retries cannot duplicate issues.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${orgId}:${member.user_id}:${projectId}:${key}`,
  ]);
  const operation = `create_issue:${projectId}`;
  const hash = createHash("sha256")
    .update(JSON.stringify(input, Object.keys(input).sort()))
    .digest("hex");
  const prior = await tx.query(
    "SELECT request_hash,response FROM app.idempotency_records WHERE org_id=$1 AND user_id=$2 AND operation=$3 AND key=$4",
    [orgId, member.user_id, operation, key],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].request_hash !== hash)
      throw new Problem(
        409,
        "idempotency_conflict",
        "This request key was already used for different data.",
      );
    return prior.rows[0].response as Issue;
  }
  // Exclusive counter lock first avoids lock upgrades when two members create concurrently.
  const project = await tx.query(
    "UPDATE app.projects SET next_issue_number=next_issue_number+1 WHERE org_id=$1 AND id=$2 AND archived_at IS NULL RETURNING next_issue_number-1 AS number",
    [orgId, projectId],
  );
  if (!project.rows[0]) {
    await projectAccess(tx, orgId, projectId, true);
    throw new Problem(404, "not_found", "Project not found.");
  }
  await assigneeAccess(tx, orgId, input.assigneeMembershipId);
  const { rows } = await tx.query<Issue>(
    `INSERT INTO app.issues(org_id,project_id,number,title,description,priority,planning_state,assignee_membership_id,creator_membership_id,due_date,rank) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$3*1024) RETURNING ${fields}`,
    [
      orgId,
      projectId,
      project.rows[0].number,
      input.title,
      input.description ?? "",
      input.priority ?? "normal",
      input.planningState ?? "planned",
      input.assigneeMembershipId ?? null,
      member.id,
      input.dueDate ?? null,
    ],
  );
  const issue = rows[0]!;
  await record(tx, orgId, issue, member, "issue.created", {});
  await tx.query(
    "INSERT INTO app.idempotency_records(org_id,user_id,operation,key,request_hash,response) VALUES($1,$2,$3,$4,$5,$6)",
    [orgId, member.user_id, operation, key, hash, JSON.stringify(issue)],
  );
  return issue;
}
export async function listIssues(
  tx: Transaction,
  orgId: string,
  projectId: string,
  limit: number,
  after?: string,
  planning?: string,
) {
  await projectAccess(tx, orgId, projectId);
  const result = await tx.query<Issue>(
    `SELECT ${fields} FROM app.issues WHERE org_id=$1 AND project_id=$2 AND ($3::uuid IS NULL OR id>$3) AND ($4::text IS NULL OR planning_state=$4) ORDER BY id LIMIT $5`,
    [orgId, projectId, after ?? null, planning ?? null, limit + 1],
  );
  return {
    items: result.rows.slice(0, limit),
    nextCursor: result.rows.length > limit ? result.rows[limit - 1]!.id : null,
  };
}
export async function updateIssue(
  tx: Transaction,
  orgId: string,
  issueId: string,
  member: Membership,
  input: UpdateIssue,
  expected: number,
) {
  const existing = await tx.query<Issue>(
    `SELECT ${fields} FROM app.issues WHERE org_id=$1 AND id=$2`,
    [orgId, issueId],
  );
  const old = existing.rows[0];
  if (!old) throw new Problem(404, "not_found", "Task not found.");
  await projectAccess(tx, orgId, old.project_id, true);
  await assigneeAccess(tx, orgId, input.assigneeMembershipId);
  const values: unknown[] = [orgId, issueId, expected];
  const setters: string[] = [];
  const mapping: Record<string, string> = {
    title: "title",
    description: "description",
    priority: "priority",
    status: "status",
    planningState: "planning_state",
    assigneeMembershipId: "assignee_membership_id",
    dueDate: "due_date",
  };
  for (const [key, value] of Object.entries(input)) {
    const column = mapping[key];
    if (!column) continue;
    values.push(value);
    setters.push(`${column}=$${values.length}`);
  }
  if (!setters.length)
    throw new Problem(
      400,
      "empty_patch",
      "Choose at least one field to change.",
    );
  const status = input.status ?? old.status;
  if (status === "done" && input.planningState !== "planned") {
    if (input.planningState === "backlog")
      throw new Problem(
        409,
        "invalid_planning_state",
        "Completed work cannot be in the backlog.",
      );
    setters.push("planning_state='planned'");
  }
  const result = await tx.query<Issue>(
    `UPDATE app.issues SET ${setters.join(",")},version=version+1,updated_at=now() WHERE org_id=$1 AND id=$2 AND version=$3 RETURNING ${fields}`,
    values,
  );
  if (!result.rows[0])
    throw new Problem(
      412,
      "stale_version",
      "This task changed. Refresh it before saving again.",
    );
  const issue = result.rows[0];
  // Activity tracks selected operational fields; don't duplicate private description bodies.
  await record(tx, orgId, issue, member, "issue.updated", {
    status: { before: old.status, after: issue.status },
    priority: { before: old.priority, after: issue.priority },
  });
  return issue;
}
