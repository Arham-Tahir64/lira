import { test, expect } from "@playwright/test";
const orgId = "00000000-0000-4000-8000-000000000001";
const userId = "00000000-0000-4000-8000-000000000003";
test("owner creates an email-bound invitation and manages a team", async ({
  page,
}, testInfo) => {
  const members = [
    {
      id: "00000000-0000-4000-8000-000000000004",
      user_id: userId,
      display_name: "Alex",
      role: "owner",
      state: "active",
    },
    {
      id: "00000000-0000-4000-8000-000000000005",
      user_id: "00000000-0000-4000-8000-000000000006",
      display_name: "Sam",
      role: "member",
      state: "active",
    },
  ];
  const invitations: Array<Record<string, unknown>> = [];
  const teams: Array<{ id: string; name: string; member_ids: string[] }> = [];
  const session = {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`,
    refresh_token: "fixture-refresh",
    expires_in: 3600,
    token_type: "bearer",
    user: {
      id: userId,
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
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/me/organizations"))
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
    if (path.endsWith("/projects")) return route.fulfill({ json: [] });
    if (path.endsWith("/members")) return route.fulfill({ json: members });
    if (path.endsWith("/invitations") && request.method() === "GET")
      return route.fulfill({ json: invitations });
    if (path.endsWith("/invitations") && request.method() === "POST") {
      const body = request.postDataJSON();
      const invitation = {
        id: crypto.randomUUID(),
        email: body.email,
        role: body.role,
        expires_at: new Date(Date.now() + 604800000).toISOString(),
        created_at: new Date().toISOString(),
        accepted_at: null,
        revoked_at: null,
        email_status: "queued",
      };
      invitations.push(invitation);
      return route.fulfill({
        status: 201,
        json: { ...invitation, token: "A".repeat(43) },
      });
    }
    if (path.endsWith("/invitations/accept"))
      return route.fulfill({ status: 201, json: { orgId } });
    if (path.endsWith("/teams") && request.method() === "GET")
      return route.fulfill({ json: teams });
    if (path.endsWith("/teams") && request.method() === "POST") {
      const team = {
        id: crypto.randomUUID(),
        name: request.postDataJSON().name,
        member_ids: [],
      };
      teams.push(team);
      return route.fulfill({ status: 201, json: team });
    }
    if (path.includes("/teams/") && request.method() === "PUT") {
      teams[0]!.member_ids.push(path.split("/").at(-1)!);
      return route.fulfill({ status: 204 });
    }
    if (path.includes("/members/") && request.method() === "PATCH") {
      const member = members.find((m) => path.endsWith(m.id))!;
      member.role = request.postDataJSON().role;
      return route.fulfill({ json: member });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill("alex@university.ca");
  await page.getByLabel("Password", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "People & teams", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "People & teams", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await page.getByLabel("Email", { exact: true }).fill("sam@university.ca");
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(
    page.getByText(
      "Invitation email queued. You can also copy the link below.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Invitation link")).toHaveValue(
    /#invite=A{43}$/,
  );
  await expect(
    page.getByText("Only that verified email can accept it.", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "New team", exact: true }).click();
  await page.getByLabel("Team name").fill("Events committee");
  await page.getByRole("button", { name: "Create team", exact: true }).click();
  await page
    .getByRole("button", { name: "Manage members", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "Sam", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Sam", exact: true }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await page.getByLabel("Role for Sam").selectOption("admin");
  await page.getByLabel("Confirm your password").fill("test-password");
  await page
    .getByRole("button", { name: "Confirm change", exact: true })
    .click();
  await expect(page.getByLabel("Role for Sam")).toHaveValue("admin");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `work/${testInfo.project.name}-people.png`,
    fullPage: true,
  });
  await page.evaluate(() => {
    location.hash = `invite=${"A".repeat(43)}`;
  });
  await expect(
    page.getByRole("heading", { name: "Join your club workspace" }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Join your club workspace" }),
  ).toHaveCount(0);
});
