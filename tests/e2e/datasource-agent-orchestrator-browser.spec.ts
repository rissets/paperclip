import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * P1-05, P1-06, P7-01: Enterprise Datasource Orchestrator Browser Contract
 * 
 * Verifies browser flows for:
 * 1. Agent Data Sources tab navigation and Enterprise Orchestrator card display
 * 2. Custom agent configuration: Mode Auto/Off, assignment scope selection, and saving
 * 3. Access revocation (Mode: None) disables orchestration and displays non-active state
 * 4. Datasources management and readiness UI
 */

interface SeedContext {
  companyId: string;
  prefix: string;
  agentId: string;
  sourceId: string;
}

async function seedCompanyWithAgentAndSource(request: APIRequestContext): Promise<SeedContext> {
  // 1. Create company
  const compRes = await request.post("/api/companies", {
    data: { name: `Datasource E2E ${Date.now()}` },
  });
  expect(compRes.ok(), `create company failed: ${await compRes.text()}`).toBe(true);
  const company = await compRes.json();
  const prefix = company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E";

  // 2. Create custom data agent
  const agentRes = await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Custom Analytics Specialist",
      adapterType: "pi_local",
      role: "general",
    },
  });
  expect(agentRes.ok(), `create agent failed: ${await agentRes.text()}`).toBe(true);
  const agent = await agentRes.json();

  // 3. Create ready test data source via upload
  const csvContent = "id,revenue,region\n1,10000000,Jakarta\n2,20000000,Bandung\n";
  const dsRes = await request.post(`/api/companies/${company.id}/data-sources/upload`, {
    multipart: {
      file: {
        name: "orders.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csvContent),
      },
    },
  });
  expect(dsRes.ok(), `upload data source failed: ${await dsRes.text()}`).toBe(true);
  const uploadResult = await dsRes.json();
  const dataSource = Array.isArray(uploadResult) ? uploadResult[0] : (uploadResult.sources?.[0] || uploadResult);

  return {
    companyId: company.id,
    prefix,
    agentId: agent.id,
    sourceId: dataSource.id,
  };
}

test.describe("P1-05, P1-06 & P7-01: Datasource Orchestrator Browser Acceptance", () => {
  test("custom agent data sources tab renders Enterprise Orchestrator card and supports Auto/Off saving", async ({
    page,
    request,
  }) => {
    const seed = await seedCompanyWithAgentAndSource(request);

    // Navigate to Agent Data Sources tab
    await page.goto(`/${seed.prefix}/agents/${seed.agentId}/data-sources`);
    await page.waitForLoadState("domcontentloaded");

    // Verify Enterprise Orchestrator card is visible
    const orchCard = page.locator("text=Enterprise Orchestrator").first();
    await expect(orchCard).toBeVisible({ timeout: 15_000 });

    // Verify presence of Mode buttons
    const autoBtn = page.getByRole("button", { name: /Auto/i });
    const offBtn = page.getByRole("button", { name: "Off" });
    await expect(autoBtn).toBeVisible();
    await expect(offBtn).toBeVisible();

    // Select Scoped access mode
    const scopedCard = page.locator("text=Pilih Koleksi / Data Source (Scoped)").first();
    await scopedCard.click();

    // Ensure Auto mode is selected
    await autoBtn.click();

    // Select our created data source
    const dsItem = page.locator(`text=orders.csv`).first();
    await expect(dsItem).toBeVisible();
    await dsItem.click();

    // Save changes
    const saveBtn = page.getByRole("button", { name: /Simpan/i });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Wait for toast or save success
    await expect(page.locator("text=Akses Data Source Diperbarui")).toBeVisible({ timeout: 10_000 });

    // Reload page to verify persistence
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Verify effective active state persists
    await expect(page.locator("text=Enterprise Orchestrator").first()).toBeVisible();
    await expect(page.locator("text=Status: Aktif").first()).toBeVisible();

    // Now test Revocation: switch to Isolated / None mode
    const isolatedCard = page.locator("text=Tidak Ada Akses (Terisolasi)").first();
    await isolatedCard.click();

    // Save revoked configuration
    await saveBtn.click();
    await expect(page.locator("text=Akses Data Source Diperbarui")).toBeVisible({ timeout: 10_000 });

    // Reload page to verify revocation persists
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Verify orchestration status changes to Nonaktif
    await expect(page.locator("text=Status: Nonaktif").first()).toBeVisible();
    await expect(page.locator("text=Catatan: Akses data source saat ini adalah Terisolasi").first()).toBeVisible();
  });

  test("datasources list page renders readiness status and source cards", async ({
    page,
    request,
  }) => {
    const seed = await seedCompanyWithAgentAndSource(request);

    // Navigate to Datasources list
    await page.goto(`/${seed.prefix}/data-sources`);
    await page.waitForLoadState("domcontentloaded");

    // Switch to All Data Sources tab
    const allTab = page.getByRole("button", { name: /All Data Sources/i });
    await expect(allTab).toBeVisible({ timeout: 15_000 });
    await allTab.click();

    // Verify orders.csv source card is listed
    await expect(page.locator("text=orders.csv").first()).toBeVisible({ timeout: 15_000 });
  });
});
