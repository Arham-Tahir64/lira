import { templates as projectTemplates } from "../../server/src/templates.js";
import { test, expect } from "@playwright/test";
const org = "00000000-0000-4000-8000-000000000001",
  projectId = "00000000-0000-4000-8000-000000000002",
  user = "00000000-0000-4000-8000-000000000003",
  member = "00000000-0000-4000-8000-000000000004";
test("owner checks the overview, edits an assigned task, creates a template project, and downloads an export", async ({
  page,
}) => {
  const tasks = [
    {
      id: crypto.randomUUID(),
      project_id: projectId,
      number: 1,
      title: "Confirm the venue",
      description: "Ask about room access.",
      status: "todo",
      priority: "high",
      planning_state: "planned",
      due_date: "2026-08-01",
      assignee_membership_id: member,
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  const projects = [
    {
      id: projectId,
      name: "Welcome week",
      key: "EVENT",
      description: "A good start to the semester.",
      lead_membership_id: member,
      term: "Fall 2026",
      archived_at: null,
    },
  ];
  const exports: Array<{
    id: string;
    state: string;
    created_at: string;
    expires_at: string;
    snapshot_at: string | null;
    bytes: number | null;
    failure: string | null;
  }> = [];
  const templates = projectTemplates;
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: user, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`,
    refresh_token: "fixture",
    expires_in: 3600,
    token_type: "bearer",
    user: {
      id: user,
      email: "alex@university.ca",
      aud: "authenticated",
      app_metadata: { provider: "email" },
      user_metadata: {},
    },
  };
  await page.route("**/api/config", (r) =>
    r.fulfill({
      json: {
        supabaseUrl: "https://fixture.supabase.co",
        supabasePublicKey: "fixture",
      },
    }),
  );
  await page.route("https://fixture.supabase.co/auth/v1/**", (r) =>
    r.fulfill({ json: session }),
  );
  await page.route("https://fixture.supabase.co/storage/v1/**", (r) => {
    expect(r.request().headers().authorization).toBeUndefined();
    return r.fulfill({
      headers: {
        "Content-Disposition": 'attachment; filename="lira-export.json"',
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ format: "lira-export", projects, tasks }),
    });
  });
  await page.route("**/api/v1/**", async (r) => {
    const req = r.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (path.endsWith("/me/organizations"))
      return r.fulfill({
        json: [
          { id: org, name: "Campus Collective", slug: "campus", role: "owner" },
        ],
      });
    if (path.endsWith("/me")) return r.fulfill({ json: { id: user } });
    if (path.endsWith("/projects")) {
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        expect(body.clientKey).toMatch(/^[a-f0-9-]{36}$/);
        expect(body.templateId).toBe("semester");
        expect(body.term).toBe("Winter 2027");
        const project = {
          id: crypto.randomUUID(),
          name: body.name,
          key: body.key,
          description: body.description,
          lead_membership_id: member,
          term: body.term,
          archived_at: null,
        };
        projects.push(project);
        tasks.push({
          ...tasks[0]!,
          id: crypto.randomUUID(),
          project_id: project.id,
          number: 1,
          title: "Prepare the executive handoff",
          description: "Record open commitments.",
        });
        return r.fulfill({ status: 201, json: project });
      }
      return r.fulfill({ json: projects });
    }
    if (path.endsWith("/templates")) return r.fulfill({ json: templates });
    if (path.endsWith("/members"))
      return r.fulfill({
        json: [
          {
            id: member,
            user_id: user,
            display_name: "Alex",
            role: "owner",
            state: "active",
          },
        ],
      });
    if (path.endsWith("/labels")) return r.fulfill({ json: [] });
    if (path.endsWith("/dashboard"))
      return r.fulfill({
        json: {
          today: "2026-09-07",
          counts: {
            assigned: 1,
            overdue: 1,
            todo: 1,
            in_progress: 0,
            done: 0,
            backlog: 0,
          },
          projects: projects.map((p) => ({
            ...p,
            total: 1,
            done: 0,
            overdue: 1,
          })),
        },
      });
    if (path.endsWith("/dashboard/tasks"))
      return r.fulfill({
        json: {
          items: tasks
            .filter((t) => t.project_id === projectId)
            .map((t) => ({
              ...t,
              project_key: "EVENT",
              project_name: "Welcome week",
            })),
          nextCursor: null,
        },
      });
    if (path.endsWith("/exports")) {
      if (req.method() === "POST") {
        const item = {
          id: crypto.randomUUID(),
          state: "ready",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          snapshot_at: new Date().toISOString(),
          bytes: 512,
          failure: null,
        };
        exports.push(item);
        return r.fulfill({ status: 202, json: { id: item.id } });
      }
      return r.fulfill({ json: { enabled: true, items: exports } });
    }
    if (path.endsWith("/download"))
      return r.fulfill({
        json: {
          url: "https://fixture.supabase.co/storage/v1/object/sign/exports/fixture?token=fixture",
        },
      });
    if (path.endsWith("/issues"))
      return r.fulfill({
        json: {
          items: tasks.filter(
            (t) =>
              path.includes(t.project_id) &&
              t.status === url.searchParams.get("status"),
          ),
          nextCursor: null,
        },
      });
    if (path.includes("/issues/")) {
      const task = tasks.find((t) => path.endsWith(t.id));
      if (task) {
        if (req.method() === "PATCH") {
          const body = req.postDataJSON();
          task.title = body.title;
          task.version++;
        }
        return r.fulfill({ json: task });
      }
    }
    return r.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("alex@university.ca");
  await page.getByLabel("Password", { exact: true }).fill("test-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Workspace overview", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What needs your attention?" }),
  ).toBeVisible();
  await expect(page.getByLabel("Workspace task counts")).toContainText(
    "Assigned to you",
  );
  await expect(page.getByLabel("Project progress")).toContainText(
    "0 of 1 done",
  );
  await page.getByRole("button", { name: "Overdue work", exact: true }).click();
  await page
    .getByLabel("Tasks needing attention")
    .getByRole("button", { name: /Confirm the venue/ })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Confirm venue access");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(page.getByLabel("Tasks needing attention")).toContainText(
    "Confirm venue access",
  );
  await page
    .getByRole("button", { name: "Request workspace export", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Download export", exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download export", exact: true })
    .click();
  expect((await downloaded).suggestedFilename()).toBe("lira-export.json");
  await page.screenshot({
    path: "work/desktop-overview.png",
    animations: "disabled",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).fill("Executive handoff");
  await dialog.getByRole("textbox", { name: /^Project key/ }).fill("TERM");
  await dialog
    .getByLabel("Semester or term", { exact: true })
    .fill("Winter 2027");
  await dialog
    .getByRole("combobox", { name: "Start from", exact: true })
    .selectOption("semester");
  await expect(dialog).toContainText("Prepare the executive handoff");
  await page.screenshot({
    path: "work/desktop-template.png",
    animations: "disabled",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Executive handoff", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Prepare the executive handoff",
      exact: true,
    }),
  ).toBeVisible();
});
