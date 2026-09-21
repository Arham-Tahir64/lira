import { test, expect } from "@playwright/test";
const orgId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
test("member signs in, creates work, changes status, and switches view", async ({
  page,
}, testInfo) => {
  let notificationRead = false;
  let emailPreference = false;
  let archived: string | null = null;
  const labelId = "00000000-0000-4000-8000-000000000008";
  const memberId = "00000000-0000-4000-8000-000000000009";
  let appliedLabels: string[] = [];
  const attachments: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
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
  await page.route(
    "https://fixture.supabase.co/storage/v1/**",
    async (route) => {
      expect(route.request().headers().authorization).toBeUndefined();
      if (route.request().method() === "PUT")
        return route.fulfill({ status: 200, json: { Key: "fixture" } });
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Disposition": 'attachment; filename="handoff.txt"',
        },
        body: "Club handoff notes",
      });
    },
  );
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/attachments")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        expect(body.checksum).toMatch(/^[a-f0-9]{64}$/);
        const item = {
          id: crypto.randomUUID(),
          name: body.name,
          bytes: body.bytes,
          media_type: body.mediaType,
          state: "pending",
          uploader_membership_id: memberId,
          created_at: new Date().toISOString(),
          rejection: null,
        };
        attachments.push(item);
        return route.fulfill({
          status: 201,
          json: {
            id: item.id,
            uploadUrl:
              "https://fixture.supabase.co/storage/v1/object/upload/sign/fixture?token=fixture",
          },
        });
      }
      return route.fulfill({
        json: {
          items: attachments,
          nextCursor: null,
          uploadEnabled: true,
          usedBytes: attachments.length * 10485760,
          quotaBytes: 1073741824,
          maxFileBytes: 10485760,
        },
      });
    }
    if (url.pathname.includes("/attachments/")) {
      const item = attachments.find((a) =>
        url.pathname.includes(String(a.id)),
      )!;
      if (url.pathname.endsWith("/complete")) {
        item.state = "quarantined";
        return route.fulfill({ json: { state: item.state } });
      }
      if (url.pathname.endsWith("/download"))
        return route.fulfill({
          json: {
            url: "https://fixture.supabase.co/storage/v1/object/sign/fixture?token=fixture&download=handoff.txt",
          },
        });
      item.state = "deleting";
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/comments")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        const comment = {
          id: crypto.randomUUID(),
          issue_id: url.pathname.split("/").at(-2),
          author_membership_id: memberId,
          author_name: "Alex",
          body: body.body,
          version: 1,
          created_at: new Date().toISOString(),
          edited_at: null,
          deleted_at: null,
        };
        comments.push(comment);
        return route.fulfill({ status: 201, json: { id: comment.id } });
      }
      return route.fulfill({ json: { items: comments, nextCursor: null } });
    }
    if (url.pathname.includes("/comments/")) {
      const comment = comments.find((c) =>
        url.pathname.endsWith(String(c.id)),
      )!;
      expect(request.headers()["if-match"]).toBe(`"${comment.version}"`);
      comment.version = Number(comment.version) + 1;
      if (request.method() === "DELETE") {
        comment.body = "";
        comment.deleted_at = new Date().toISOString();
      } else {
        comment.body = request.postDataJSON().body;
        comment.edited_at = new Date().toISOString();
      }
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/move")) {
      const id = url.pathname.split("/").at(-2);
      const issue = issues.find((i) => i.id === id)!;
      const body = request.postDataJSON();
      expect(body.expectedVersion).toBe(issue.version);
      Object.assign(issue, {
        status: body.status,
        planning_state: body.planningState,
        version: Number(issue.version) + 1,
      });
      issues.splice(issues.indexOf(issue), 1);
      const index = issues.findIndex((i) => i.id === body.beforeId);
      if (index < 0) issues.push(issue);
      else issues.splice(index, 0, issue);
      return route.fulfill({ json: issue });
    }
    if (url.pathname.endsWith("/notification-preferences")) {
      if (request.method() === "PUT") {
        emailPreference = request.postDataJSON().assignmentEmail;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({
        json: { assignmentEmail: emailPreference, emailAvailable: true },
      });
    }
    if (
      url.pathname.endsWith(
        "/notifications/00000000-0000-4000-8000-000000000099",
      )
    ) {
      notificationRead = request.postDataJSON().read;
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/notifications"))
      return route.fulfill({
        json: {
          items:
            url.searchParams.get("unread") === "true" && notificationRead
              ? []
              : [
                  {
                    id: "00000000-0000-4000-8000-000000000099",
                    project_id: projectId,
                    issue_id: "task",
                    title: "Review volunteer schedule",
                    number: 9,
                    project_key: "EVENT",
                    read_at: notificationRead ? new Date().toISOString() : null,
                    created_at: new Date().toISOString(),
                  },
                ],
          nextCursor: null,
        },
      });
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
              (!url.searchParams.get("planningState") ||
                i.planning_state === url.searchParams.get("planningState")) &&
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
        status: body.status ?? "todo",
        planning_state: body.planningState ?? "planned",
        assignee_membership_id: body.assigneeMembershipId ?? null,
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
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Notifications", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Review volunteer schedule", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Email me about assignments", { exact: true }).click();
  await expect(
    page.getByLabel("Email me about assignments", { exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: "work/desktop-notifications.png",
    animations: "disabled",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Mark unread", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Unread only", { exact: true }).check();
  await expect(
    page.getByText("No unread notifications.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Unread only", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Open project", exact: true }).click();
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
  await dialog.getByRole("button", { name: "Discussion", exact: true }).click();
  await dialog
    .getByLabel("Add a comment", { exact: true })
    .fill(
      "**Venue booked**. [Unsafe](javascript:alert(1)) <script>window.bad=1</script> ![tracker](https://tracker.example/x)",
    );
  await dialog
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await expect(
    dialog.locator("strong").filter({ hasText: "Venue booked" }),
  ).toBeVisible();
  await expect(dialog.locator("script,img")).toHaveCount(0);
  expect(
    await dialog.getByRole("link", { name: "Unsafe" }).getAttribute("href"),
  ).not.toMatch(/^javascript:/i);
  await dialog.getByRole("button", { name: "Edit", exact: true }).click();
  await dialog
    .getByRole("textbox", { name: "Edit comment", exact: true })
    .fill("**Venue confirmed** — capacity is 80.");
  await dialog
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(
    dialog.locator("strong").filter({ hasText: "Venue confirmed" }),
  ).toBeVisible();
  await page.screenshot({
    path: "work/desktop-discussion.png",
    animations: "disabled",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Confirm delete", exact: true })
    .click();
  await expect(
    dialog.getByText("Comment removed", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Attachments", exact: true })
    .click();
  await dialog.getByLabel("Choose attachment").setInputFiles({
    name: "handoff.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Club handoff notes"),
  });
  await dialog
    .getByRole("button", { name: "Upload attachment", exact: true })
    .click();
  await expect(dialog.getByText("handoff.txt", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Validating/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Download", exact: true }),
  ).toHaveCount(0);
  attachments[0]!.state = "ready";
  await dialog
    .getByRole("button", { name: "Refresh attachments", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Download", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "work/desktop-attachments.png",
    animations: "disabled",
    fullPage: true,
  });
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe("handoff.txt");
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Confirm remove", exact: true })
    .click();
  await expect(dialog.getByText(/Removed · cleanup pending/)).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Download", exact: true }),
  ).toHaveCount(0);
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
  await page
    .getByRole("button", { name: "Add task to in progress", exact: false })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Title", { exact: true })
    .fill("Recruit volunteers");
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Assignee", exact: true })
    .selectOption(memberId);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create task", exact: true })
    .click();
  await expect(
    page
      .getByLabel("In progress column")
      .getByText("Recruit volunteers", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Drag Recruit volunteers", { exact: true })
    .dragTo(page.getByLabel("To do column", { exact: true }));
  await expect(
    page
      .getByLabel("To do column")
      .getByText("Recruit volunteers", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("To do column")
    .getByRole("button", { name: "Send to backlog", exact: true })
    .click();
  await expect(
    page.getByText("Recruit volunteers", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Backlog", exact: true }).click();
  await expect(
    page.getByText("Recruit volunteers", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Plan task", exact: true }).click();
  await expect(
    page.getByText("Recruit volunteers", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Tasks/ }).click();
  await expect(
    page
      .getByLabel("To do column")
      .getByText("Recruit volunteers", { exact: true }),
  ).toBeVisible();
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
