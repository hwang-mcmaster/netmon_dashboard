import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
test("target configuration, incident, acknowledgement, recovery and archive", async ({
  page,
  request,
}) => {
  const name = `E2E lifecycle ${Date.now()}`;
  await request.post("http://127.0.0.1:8099/control/recover");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Network overview" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add target" }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page
    .getByLabel("URL (no credentials or query string)")
    .fill("http://127.0.0.1:8099/toggle");
  await page.getByLabel("Interval (ms)").fill("1000");
  await page.getByLabel("Timeout (ms)").fill("300");
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByPlaceholder("Name or destination…").fill(name);
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name, exact: true }) });
  await expect(row.getByText("healthy", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  const targets = await (
    await request.get(`/api/targets?q=${encodeURIComponent(name)}`)
  ).json();
  const id = targets.items[0].id;
  await request.post("http://127.0.0.1:8099/control/fail");
  await expect
    .poll(
      async () =>
        (
          await (await request.get(`/api/targets/${id}`)).json()
        ).incidents.filter((i) => !i.recovered_at).length,
      { timeout: 15000 },
    )
    .toBe(1);
  await expect(row.getByText("1 open")).toBeVisible({ timeout: 10000 });
  const incident = page
    .locator(".incident")
    .filter({ has: page.getByText(name, { exact: true }) });
  await incident.getByRole("button", { name: "Acknowledge" }).click();
  await expect(
    incident.getByRole("button", { name: "Acknowledged" }),
  ).toBeDisabled();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Recent latency · milliseconds" }),
  ).toBeVisible();
  await request.post("http://127.0.0.1:8099/control/recover");
  await expect
    .poll(
      async () =>
        (
          await (await request.get(`/api/targets/${id}`)).json()
        ).incidents.every((i) => i.recovered_at),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(page.getByText(/Recovered /)).toBeVisible({ timeout: 10000 });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Monitoring enabled").uncheck();
  await page.getByRole("button", { name: "Save target" }).click();
  await expect(row.getByText("disabled", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(row).toHaveCount(0);
});
test("partial refresh failure preserves working sections and recovers", async ({
  page,
}) => {
  await page.route("**/api/operations", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic operations outage" }),
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic operations outage",
  );
  await expect(
    page.getByRole("button", { name: "Demo · storefront", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/operations");
  await page.getByRole("button", { name: "Refresh", exact: false }).click();
  await expect(page.getByRole("alert")).toBeHidden();
});
for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 1050 }],
  ["mobile", { width: 390, height: 844 }],
])
  test(`${name} dashboard, focus, configuration and screenshot`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Demo · storefront", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".aside-bottom")).toContainText(
      "Worker connected",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).toHaveCount(1);
    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.getByRole("button", { name: "Add target" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await mkdir("docs/screenshots", { recursive: true });
    await page.screenshot({
      path: `docs/screenshots/${name}.png`,
      fullPage: true,
    });
  });
