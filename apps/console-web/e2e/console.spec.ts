import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const images = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/public/images");

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("admin@readmeter.local");
  await page.getByLabel("Password").fill("readmeter-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
}

test("console covers overview, findings, keys, invites, and the sidebar", async ({ page }) => {
  mkdirSync(images, { recursive: true });
  await signIn(page);

  await page.goto("/w/local/overview?project=demo_local&range=7d");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  for (const label of ["Events", "Estimated", "Wasted", "Open issues"]) {
    await expect(page.locator("[data-slot=card-title]", { hasText: label }).first()).toBeVisible();
  }
  await expect(page.getByTestId("severity-chart").getByText("Critical")).toBeVisible();
  await expect(page.getByTestId("top-rules")).toBeVisible();
  await page.screenshot({ path: path.join(images, "console-overview.png") });

  await page.goto("/w/local/findings?project=demo_local&range=7d");
  await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
  await expect(page.getByTestId("findings-table").getByText(/unbounded-list/)).toBeVisible();
  await expect(async () => {
    const popover = page.locator("[data-slot=popover-content]");
    if (!(await popover.isVisible())) {
      await page.getByRole("button", { name: "Filter" }).click();
      await expect(popover).toBeVisible();
    }
    const severity = page.getByRole("button", { name: "Severity filter values" });
    if (!(await severity.isVisible())) {
      await page.getByRole("button", { name: "Add filter" }).click();
      await expect(severity).toBeVisible();
    }
  }).toPass();
  await page.getByRole("button", { name: "Severity filter values" }).click();
  await expect(page.getByRole("option", { name: "Critical" })).toBeVisible();
  await page.getByRole("option", { name: "Critical" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("columnheader", { name: "Sessions" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Occurrences" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Message" })).toHaveCount(0);
  await expect(page.getByText(/unbounded-list/).first()).toBeVisible();
  await expect(page.getByText(/offset-pagination/)).toHaveCount(0);
  const fits = await page.getByTestId("findings-table").locator("[data-slot=table-container]").evaluate((el) => {
    return el.scrollWidth <= el.clientWidth + 1;
  });
  expect(fits).toBe(true);
  await page.screenshot({ path: path.join(images, "console-findings.png") });

  await page.getByText(/unbounded-list/).first().click();
  await expect(page.getByTestId("finding-status")).toBeVisible();
  await expect(page.getByTestId("finding-sessions")).toBeVisible();
  await expect(page.getByTestId("finding-callsite")).toBeVisible();
  await expect(page.getByTestId("finding-occurrences")).toBeVisible();
  await page.getByTestId("finding-status").click();
  await page.getByRole("option", { name: "Resolved" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Finding updated")).toBeVisible();

  await page.goto("/w/local/keys?project=demo_local&range=7d");
  await page.getByRole("button", { name: "Create key" }).click();
  await page.getByLabel("Name").fill(`e2e-${Date.now()}`);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("api-key-secret")).toContainText("rm_live_");

  await page.goto("/w/local/members?project=demo_local&range=7d");
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByLabel("Emails").fill(`e2e-${Date.now()}@readmeter.local`);
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByTestId("invite-link")).toContainText("accept-invitation");

  await page.locator("[data-slot=sidebar-trigger]").click();
  await expect(page.locator("[data-slot=sidebar][data-collapsible=icon]")).toBeVisible();
  await expect(page.locator("[data-slot=sidebar-group-label]", { hasText: "Monitor" })).toHaveCSS("opacity", "0");
  const overview = page.getByRole("link", { name: "Overview" });
  const box = await overview.boundingBox();
  expect(box?.width ?? 999).toBeLessThan(48);
});

test("toggling a rule survives reload", async ({ page }) => {
  await signIn(page);
  const filters = encodeURIComponent(
    JSON.stringify([{ id: "title", value: "Same request", variant: "text", operator: "iLike", filterId: "e2e" }]),
  );
  await page.goto(`/w/local/rules?project=demo_local&range=7d&rfilters=${filters}`);
  const toggle = page.getByRole("switch", { name: "Enable generic/duplicate-read" });
  await expect(toggle).toBeVisible();
  const before = (await toggle.getAttribute("aria-checked")) === "true";
  await toggle.click();
  await expect(page.getByText("Override saved")).toBeVisible();
  await page.reload();
  const again = page.getByRole("switch", { name: "Enable generic/duplicate-read" });
  await expect(again).toHaveAttribute("aria-checked", before ? "false" : "true");
  await again.click();
  await expect(page.getByText("Override saved")).toBeVisible();
});

test("gcp wizard shows a failed check, then billed costs", async ({ page }) => {
  await signIn(page);
  await page.goto("/w/local/integrations?project=demo_local&range=7d");
  await expect(page.getByRole("heading", { name: "Integrations" })).toBeVisible();
  await page.getByTestId("gcp-connect").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByTestId("gcp-key").fill(
    JSON.stringify({
      type: "service_account",
      client_email: "fail@readmeter.invalid",
      private_key: "fake-private-key",
      project_id: "demo-readmeter",
    }),
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Billing export table").fill("demo-readmeter.billing.gcp_billing_export_v1");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByTestId("gcp-test-results")).toContainText("monitoring denied");

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByTestId("gcp-key").fill(
    JSON.stringify({
      type: "service_account",
      client_email: "reader@demo-readmeter.iam.gserviceaccount.com",
      private_key: "fake-private-key",
      project_id: "demo-readmeter",
    }),
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByText("The key is stored")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  await page.getByTestId("gcp-sync").click();
  await expect(page.getByText("Sync queued")).toBeVisible();
  await page.goto("/w/local/costs?project=demo_local&range=7d");
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("billed-table").getByText("Read Ops")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("billed-table").getByText("$1.00")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.locator("[data-slot=badge]", { hasText: "Billed" }).first()).toBeVisible();

  await page.goto("/w/local/integrations?project=demo_local&range=7d");
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("button", { name: "Remove connection" }).click();
  await expect(page.getByText("Not connected")).toBeVisible();
});
