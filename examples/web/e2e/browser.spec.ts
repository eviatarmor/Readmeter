import { expect, test } from "@playwright/test";

test("seed, unbounded list, and offset pagination show local findings", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  const log = page.locator("#log");
  await expect(log).toContainText("ready");
  await page.getByRole("button", { name: "seed data" }).click();
  await expect(log).toContainText("seeded 300 posts");
  await page.getByRole("button", { name: "unbounded list" }).click();
  await page.getByRole("button", { name: "offset pagination" }).click();
  await expect(log).toContainText("firebase.firestore/unbounded-list");
  await expect(log).toContainText("firebase.firestore/offset-pagination");
  await page.getByRole("button", { name: "duplicate listeners" }).click();
  await expect(log).toContainText("firebase.database/duplicate-listeners");
  await page.getByRole("button", { name: "unbounded storage list" }).click();
  await expect(log).toContainText("firebase.storage/unbounded-list-page");
  await page.getByRole("button", { name: "anonymous churn" }).click();
  await expect(log).toContainText("firebase.auth/anonymous-user-churn");
  await page.getByRole("button", { name: "token refresh storm" }).click();
  await expect(log).toContainText("firebase.auth/id-token-refresh-storm");
  await page.getByRole("button", { name: "memory persistence" }).click();
  await expect(log).toContainText("firebase.auth/memory-persistence");
  await page.getByRole("button", { name: "auth listeners" }).click();
  await expect(log).toContainText("generic/listener-leak");
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
