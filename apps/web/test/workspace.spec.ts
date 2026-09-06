import { test, expect } from "@playwright/test";
const orgId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
test("member signs in, creates work, changes status, and switches view", async ({
  page,
}, testInfo) => {
  let archived: string | null = null;
  const labelId = "00000000-0000-4000-8000-000000000008";
  const memberId = "00000000-0000-4000-8000-000000000009";
  let appliedLabels: string[] = [];
  const issues: Array<Record<string, unknown>> = [];
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "00000000-0000-4000-8000-000000000003", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`,
    refresh_token: "fixture-refresh",
    expires_in: 3600,
    token_type: "bearer",
    user: {
      id: "00000000-0000-4000-8000-000000000003",
      email: "alex@university.ca",
      aud: "authenticated",
      app_metadata: { provider: "email" },
      user_metadata: {},
    },
  };
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        supabaseUrl: "https://fixture.supabase.co",
        supabasePublicKey: "fixture-public-key",
      },
    }),
  );
  await page.route("https://fixture.supabase.co/auth/v1/**", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/me/organizations"))
      return route.fulfill({
        json: [
          {
            id: orgId,
            name: "Campus Collective",
            slug: "campus",
            role: "owner",
          },
        ],
      });
    if (url.pathname.endsWith("/projects"))
      return route.fulfill({
        json: [
          {
            id: projectId,
            name: "Welcome week",
            key: "EVENT",
            description: "A good start to a new semester.",
            archived_at: archived,
          },
        ],
      });
    if (url.pathname.endsWith("/members"))
      return route.fulfill({
        json: [
          {
            id: memberId,
            user_id: session.user.id,
            display_name: "Alex",
            role: "owner",
            state: "active",
          },
        ],
      });
    if (url.pathname.endsWith("/labels"))
      return route.fulfill({
        json:
          !url.pathname.includes("/issues/") || appliedLabels.length
            ? [{ id: labelId, name: "Events", color: "#6853cc" }]
            : [],
      });
    if (
      url.pathname.endsWith("/archive") ||
      url.pathname.endsWith("/unarchive")
    ) {
      archived = url.pathname.endsWith("/unarchive")
        ? null
        : new Date().toISOString();
      return route.fulfill({ json: { archived: !!archived } });
    }
    if (url.pathname.endsWith("/activity"))
      return route.fulfill({
        json: {
          items: [
            {
              id: "event-1",
              action: "issue.updated",
              actor_name: "Alex",
              issue_number: 1,
              created_at: new Date().toISOString(),
              changes: { priority: { before: "normal", after: "high" } },
            },
          ],
          nextCursor: null,
        },
      });
    if (url.pathname.endsWith("/me"))
      return route.fulfill({ json: { id: session.user.id } });
    if (url.pathname.endsWith("/issues") && request.method() === "GET")
      return route.fulfill({
        json: {
          items: issues.filter(
            (i) =>
              (!url.searchParams.get("status") ||
                i.status === url.searchParams.get("status")) &&
              (!url.searchParams.get("q") ||
                String(i.title).includes(url.searchParams.get("q")!)),
          ),
          nextCursor: null,
        },
      });
    if (url.pathname.endsWith("/issues") && request.method() === "POST") {
      const body = request.postDataJSON();
      const issue = {
        id: crypto.randomUUID(),
        project_id: projectId,
        number: issues.length + 1,
        title: body.title,
        description: body.description,
        status: "todo",
        planning_state: "planned",
        priority: body.priority,
        due_date: body.dueDate,
        version: 1,
      };
      issues.push(issue);
      return route.fulfill({ status: 201, json: issue });
    }
    if (request.method() === "PATCH") {
      const issue = issues.find((i) => url.pathname.endsWith(String(i.id)))!;
      const body = request.postDataJSON();
      if (body.labelIds) appliedLabels = body.labelIds;
      expect(request.headers()["if-match"]).toBe(`"${issue.version}"`);
      Object.assign(issue, body, {
        assignee_membership_id:
          body.assigneeMembershipId ?? issue.assignee_membership_id,
        due_date: body.dueDate ?? issue.due_date,
        version: Number(issue.version) + 1,
      });
      return route.fulfill({ json: issue });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("alex@university.ca");
  await page.getByLabel("Password", { exact: true }).fill("test-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome week", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Book the student centre");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Confirm room capacity and step-free access.");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByText("Book the student centre", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Status for Book the student centre")
    .selectOption("in_progress");
  await expect(
    page.getByLabel("Status for Book the student centre"),
  ).toHaveValue("in_progress");
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "In progress 1" }),
  ).toBeVisible();
  await page.getByText("Book the student centre", { exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Confirm the student centre");
  await dialog
    .getByRole("combobox", { name: "Assignee", exact: true })
    .selectOption(memberId);
  await dialog
    .getByRole("combobox", { name: "Priority", exact: true })
    .selectOption("high");
  await dialog.getByLabel("Events", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByText("Confirm the student centre", { exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Assignee", exact: true }),
  ).toHaveValue(memberId);
  await expect(
    page.getByRole("dialog").getByLabel("Events", { exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: "work/desktop-editor.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await page.getByLabel("Search project tasks").fill("no match");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching tasks" }),
  ).toBeVisible();
  await page.getByLabel("Search project tasks").fill("");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("Confirm the student centre", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByText("priority: normal → high")).toBeVisible();
  await page
    .getByRole("button", { name: "Archive project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New task", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Restore project", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New task", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `work/${testInfo.project.name}-workspace.png`,
    animations: "disabled",
    fullPage: true,
  });
});
