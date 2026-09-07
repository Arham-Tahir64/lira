import { Type, type Static } from "@sinclair/typebox";
const object = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const Uuid = Type.String({ format: "uuid" });
export const Status = Type.Union([
  Type.Literal("todo"),
  Type.Literal("in_progress"),
  Type.Literal("done"),
]);
export const Priority = Type.Union([
  Type.Literal("low"),
  Type.Literal("normal"),
  Type.Literal("high"),
  Type.Literal("urgent"),
]);
export const PlanningState = Type.Union([
  Type.Literal("backlog"),
  Type.Literal("planned"),
]);
export const OrgInput = object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  slug: Type.String({
    minLength: 3,
    maxLength: 48,
    pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  }),
});
export const ProjectInput = object({
  clientKey: Type.Optional(Uuid),
  templateId: Type.Optional(
    Type.Union([Type.Literal("event"), Type.Literal("semester")]),
  ),
  term: Type.Optional(Type.String({ maxLength: 60 })),
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  key: Type.String({ pattern: "^[A-Z][A-Z0-9]{1,9}$" }),
  description: Type.Optional(Type.String({ maxLength: 5000 })),
});
export const IssueInput = object({
  status: Type.Optional(Status),
  title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
  description: Type.Optional(Type.String({ maxLength: 20000 })),
  priority: Type.Optional(Priority),
  planningState: Type.Optional(PlanningState),
  assigneeMembershipId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  dueDate: Type.Optional(
    Type.Union([Type.String({ format: "date" }), Type.Null()]),
  ),
});
export const IssuePatch = object({
  labelIds: Type.Optional(
    Type.Array(Uuid, { maxItems: 20, uniqueItems: true }),
  ),
  title: Type.Optional(
    Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
  ),
  description: Type.Optional(Type.String({ maxLength: 20000 })),
  status: Type.Optional(Status),
  planningState: Type.Optional(PlanningState),
  priority: Type.Optional(Priority),
  assigneeMembershipId: Type.Optional(Type.Union([Uuid, Type.Null()])),
  dueDate: Type.Optional(
    Type.Union([Type.String({ format: "date" }), Type.Null()]),
  ),
});
export const OrgParams = object({ orgId: Uuid });
export const ProjectParams = object({ orgId: Uuid, projectId: Uuid });
export const IssueParams = object({ orgId: Uuid, issueId: Uuid });
export const PageQuery = object({
  after: Type.Optional(Uuid),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  planningState: Type.Optional(PlanningState),
  status: Type.Optional(Status),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  assignee: Type.Optional(Uuid),
  priority: Type.Optional(Priority),
  label: Type.Optional(Uuid),
  dueBefore: Type.Optional(Type.String({ format: "date" })),
});
export type CreateIssue = Static<typeof IssueInput>;
export type UpdateIssue = Static<typeof IssuePatch>;
export type CreateOrg = Static<typeof OrgInput>;
export type CreateProject = Static<typeof ProjectInput>;
export type IssueStatus = Static<typeof Status>;
export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
}
export interface Project {
  term?: string;
  template_id?: string | null;
  id: string;
  name: string;
  key: string;
  description: string;
  lead_membership_id: string;
  archived_at: string | null;
}
export interface Membership {
  id: string;
  role: "owner" | "admin" | "member";
  user_id: string;
}
export interface Issue {
  id: string;
  project_id: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  planning_state: Static<typeof PlanningState>;
  priority: Static<typeof Priority>;
  assignee_membership_id: string | null;
  due_date: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export const IssueResponse = object({
  id: Uuid,
  project_id: Uuid,
  number: Type.Integer(),
  title: Type.String(),
  description: Type.String(),
  status: Status,
  planning_state: PlanningState,
  priority: Priority,
  assignee_membership_id: Type.Union([Uuid, Type.Null()]),
  due_date: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

export const MemberParams = object({ orgId: Uuid, membershipId: Uuid });
export const InviteParams = object({ orgId: Uuid, invitationId: Uuid });
export const TeamParams = object({ orgId: Uuid, teamId: Uuid });
export const TeamMemberParams = object({
  orgId: Uuid,
  teamId: Uuid,
  membershipId: Uuid,
});
export const InviteInput = object({
  email: Type.String({ format: "email", maxLength: 254 }),
  role: Type.Union([Type.Literal("member"), Type.Literal("admin")]),
});
export const AcceptInviteInput = object({
  token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
});
export const MemberRoleInput = object({
  role: Type.Union([
    Type.Literal("owner"),
    Type.Literal("admin"),
    Type.Literal("member"),
  ]),
});
export const TransferInput = object({ membershipId: Uuid });
export const TeamInput = object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
});
export const MemberResponse = object({
  id: Uuid,
  user_id: Uuid,
  role: Type.Union([
    Type.Literal("owner"),
    Type.Literal("admin"),
    Type.Literal("member"),
  ]),
  display_name: Type.String(),
  state: Type.Union([Type.Literal("active"), Type.Literal("inactive")]),
});
export type RosterMember = Static<typeof MemberResponse>;
export interface Invitation {
  id: string;
  email: string;
  role: "admin" | "member";
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface Team {
  id: string;
  name: string;
  member_ids: string[];
}

export const LabelInput = object({
  name: Type.String({ minLength: 1, maxLength: 40, pattern: "\\S" }),
});
export interface Label {
  id: string;
  name: string;
  color: string;
}
export const MoveInput = object({
  status: Status,
  planningState: PlanningState,
  beforeId: Type.Union([Uuid, Type.Null()]),
  expectedVersion: Type.Integer({ minimum: 1, maximum: 999999999 }),
});
export interface Activity {
  issue_number: number | null;
  id: string;
  action: string;
  actor_name: string;
  created_at: string;
  changes: Record<string, unknown>;
}

export interface Comment {
  id: string;
  issue_id: string;
  author_membership_id: string;
  author_name: string;
  body: string;
  version: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}
export const CommentInput = object({
  body: Type.String({ minLength: 1, maxLength: 10000, pattern: "\\S" }),
  clientKey: Uuid,
});
export const CommentPatch = object({
  body: Type.String({ minLength: 1, maxLength: 10000, pattern: "\\S" }),
});
export const CommentParams = object({ orgId: Uuid, commentId: Uuid });

export const AttachmentInput = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 180,
      pattern: "^[^/\\\\\\x00-\\x1f\\x7f]+$",
    }),
    mediaType: Type.Union([
      Type.Literal("application/pdf"),
      Type.Literal("image/png"),
      Type.Literal("image/jpeg"),
      Type.Literal("text/plain"),
    ]),
    bytes: Type.Integer({ minimum: 1, maximum: 10485760 }),
    checksum: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    clientKey: Uuid,
  },
  { additionalProperties: false },
);
export const AttachmentParams = Type.Object(
  { orgId: Uuid, attachmentId: Uuid },
  { additionalProperties: false },
);
export interface Attachment {
  id: string;
  name: string;
  media_type: string;
  bytes: number;
  state: "pending" | "quarantined" | "ready" | "deleting" | "deleted";
  uploader_membership_id: string;
  created_at: string;
  rejection: string | null;
}
export interface AttachmentList {
  items: Attachment[];
  nextCursor: string | null;
  uploadEnabled: boolean;
  usedBytes: number;
  quotaBytes: number;
  maxFileBytes: number;
}

export interface Dashboard {
  today: string;
  counts: {
    todo: number;
    in_progress: number;
    done: number;
    overdue: number;
    assigned: number;
    backlog: number;
  };
  projects: Array<{
    id: string;
    name: string;
    key: string;
    term: string;
    total: number;
    done: number;
    overdue: number;
  }>;
}
export interface DashboardTask {
  id: string;
  project_id: string;
  number: number;
  title: string;
  status: IssueStatus;
  priority: string;
  planning_state: string;
  due_date: string | null;
  project_key: string;
  project_name: string;
}
export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  tasks: Array<{ title: string; description: string }>;
}
export interface ExportRecord {
  id: string;
  state: "pending" | "ready" | "failed" | "expired";
  created_at: string;
  expires_at: string;
  snapshot_at: string | null;
  bytes: number | null;
  failure: string | null;
}
