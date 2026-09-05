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
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  key: Type.String({ pattern: "^[A-Z][A-Z0-9]{1,9}$" }),
  description: Type.Optional(Type.String({ maxLength: 5000 })),
});
export const IssueInput = object({
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
