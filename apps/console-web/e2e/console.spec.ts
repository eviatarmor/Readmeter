import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const images = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/images");

test("console covers overview, findings, keys, invites, and the sidebar", async ({ page }) => {
  mkdirSync(images, { recursive: true });
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("admin@readmeter.local");
  await page.getByLabel("Password").fill("readmeter-dev");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

  await page.goto("/w/local/overview?project=demo_local&range=7d");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  for (const label of ["Events", "Estimated cost", "Wasted", "Open findings"]) {
    await expect(page.locator("[data-slot=card-title]", { hasText: label }).first()).toBeVisible();
  }
  await page.screenshot({ path: path.join(images, "console-overview.png") });

  await page.goto("/w/local/findings?project=demo_local&range=7d");
  await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
  await page.getByRole("button", { name: "Filter" }).click();
  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("button", { name: "Severity filter values" }).click();
  await page.getByRole("option", { name: "Critical" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/unbounded-list/).first()).toBeVisible();
  await expect(page.getByText(/offset-pagination/)).toHaveCount(0);
  await page.screenshot({ path: path.join(images, "console-findings.png") });

  await page.getByText(/unbounded-list/).first().click();
  await expect(page.getByTestId("finding-status")).toBeVisible();
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
