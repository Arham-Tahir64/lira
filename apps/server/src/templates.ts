import { createHash, randomUUID } from "node:crypto";
import type { Static } from "@sinclair/typebox";
import type { Membership, ProjectInput } from "@lira/contracts";
import type { Transaction } from "./database.js";
import { createIssue } from "./work.js";
import { Problem } from "./problem.js";
export const templates = [
  {
    id: "event",
    name: "Event planning",
    description: "Take a club event from idea to post-event review.",
    tasks: [
      {
        title: "Define the event and audience",
        description:
          "Agree on the purpose, audience, date, and what success looks like.",
      },
      {
        title: "Confirm venue and accessibility",
        description:
          "Checklist:\n- Confirm room capacity and booking\n- Check accessible routes, washrooms, and accommodations\n- Record venue contact and cancellation terms",
      },
      {
        title: "Approve the event budget",
        description:
          "List expected costs, funding, and the person approving expenses. Do not store payment credentials here.",
      },
      {
        title: "Publish the promotion plan",
        description:
          "Prepare the announcement, registration details, and promotion schedule.",
      },
      {
        title: "Recruit and brief volunteers",
        description:
          "Agree on roles, shifts, arrival times, and an event-day contact.",
      },
      {
        title: "Run the event-day checklist",
        description:
          "Checklist:\n- Confirm supplies and room access\n- Brief volunteers\n- Check registration and accessibility arrangements\n- Clean up and return equipment",
      },
      {
        title: "Review the event and document lessons",
        description:
          "Record attendance, final costs, what worked, and recommendations for the next team.",
      },
    ],
  },
  {
    id: "semester",
    name: "Semester onboarding & handoff",
    description:
      "Onboard members and preserve knowledge for the next executive team.",
    tasks: [
      {
        title: "Set semester goals and responsibilities",
        description:
          "Agree on the term goals, team responsibilities, and key dates.",
      },
      {
        title: "Welcome and onboard members",
        description:
          "Checklist:\n- Share the club introduction\n- Invite members to the workspace\n- Introduce team leads\n- Explain how the board and backlog are used",
      },
      {
        title: "Review the roster and access",
        description:
          "Confirm current members and roles. Remove departed members through People & teams.",
      },
      {
        title: "Document recurring responsibilities",
        description:
          "List recurring meetings, university contacts, reporting deadlines, and where reference documents live.",
      },
      {
        title: "Prepare the executive handoff",
        description:
          "Checklist:\n- Summarize open projects and commitments\n- Record decisions and lessons learned\n- Identify incoming leads\n- Transfer ownership through People & teams\n- Transfer external account access using an approved password manager, never task comments",
      },
      {
        title: "Review and archive the semester",
        description:
          "Confirm the next team has access and understands outstanding work. Export records if needed, then manually archive completed projects.",
      },
    ],
  },
] as const;
export async function createProject(
  tx: Transaction,
  orgId: string,
  member: Membership,
  input: Static<typeof ProjectInput>,
) {
  const key = input.clientKey ?? randomUUID();
  const body = {
    name: input.name,
    key: input.key,
    description: input.description ?? "",
    term: input.term ?? "",
    templateId: input.templateId ?? null,
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,3))", [
    orgId,
  ]);
  const prior = (
    await tx.query(
      "SELECT request_hash,response FROM app.idempotency_records WHERE org_id=$1 AND user_id=$2 AND operation='create_project' AND key=$3",
      [orgId, member.user_id, key],
    )
  ).rows[0];
  if (prior) {
    if (prior.request_hash !== hash)
      throw new Problem(
        409,
        "idempotency_conflict",
        "This project request was already used for different data.",
      );
    return prior.response;
  }
  if (
    (
      await tx.query(
        "SELECT count(*)::int AS count FROM app.projects WHERE org_id=$1",
        [orgId],
      )
    ).rows[0].count >= 100
  )
    throw new Problem(
      409,
      "project_limit",
      "This pilot workspace has reached its 100-project limit.",
    );
  const project = (
    await tx.query(
      "INSERT INTO app.projects(org_id,name,key,description,lead_membership_id,term,template_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,key,description,lead_membership_id,archived_at,term,template_id",
      [
        orgId,
        body.name,
        body.key,
        body.description,
        member.id,
        body.term,
        body.templateId,
      ],
    )
  ).rows[0];
  await tx.query("INSERT INTO app.boards(org_id,project_id) VALUES($1,$2)", [
    orgId,
    project.id,
  ]);
  const template = templates.find((t) => t.id === body.templateId);
  for (const task of template?.tasks ?? [])
    await createIssue(
      tx,
      orgId,
      project.id,
      member,
      { ...task, planningState: "planned" },
      randomUUID(),
    );
  await tx.query(
    "INSERT INTO app.idempotency_records(org_id,user_id,operation,key,request_hash,response) VALUES($1,$2,'create_project',$3,$4,$5)",
    [orgId, member.user_id, key, hash, JSON.stringify(project)],
  );
  return project;
}
