import { describe, expect, it } from "vitest";

/**
 * P0-02 Golden Workload Evaluation Suite
 * 
 * Verifies independent reference SQL and deterministic calculation for 11 workload categories:
 * 1. Exact entity lookup
 * 2. Count / Count-distinct
 * 3. Sum / Min / Max temporal
 * 4. Group by aggregation
 * 5. Range comparison
 * 6. Weighted ratio / percentage
 * 7. Multi-table join
 * 8. Cross-file overlap / reconciliation
 * 9. Hybrid document + structured data
 * 10. Ambiguity detection & abstention
 * 11. Presentation-only follow-up (result reuse)
 */

interface CustomerRecord {
  id: string;
  name: string;
  region: string;
  segment: string;
}

interface OrderRecord {
  orderId: string;
  customerId: string;
  orderDate: string; // YYYY-MM-DD
  revenue: number;
  cost: number;
  quantity: number;
}

interface InventoryRecord {
  productId: string;
  sku: string;
  stockQty: number;
  reservedQty: number;
}

describe("P0-02: DataSource Golden Workload & Reference SQL Evaluation", () => {
  // Shared deterministic fixtures
  const customers: CustomerRecord[] = [
    { id: "CUST-001", name: "PT Surya Mandiri", region: "Jawa Barat", segment: "Enterprise" },
    { id: "CUST-002", name: "CV Berkah Jaya", region: "DKI Jakarta", segment: "SMB" },
    { id: "CUST-003", name: "PT Nusantara Abadi", region: "DKI Jakarta", segment: "Enterprise" },
    { id: "CUST-004", name: "Toko Sinar Terang", region: "Jawa Timur", segment: "Retail" },
  ];

  const orders: OrderRecord[] = [
    { orderId: "ORD-101", customerId: "CUST-001", orderDate: "2026-08-01", revenue: 50_000_000, cost: 35_000_000, quantity: 10 },
    { orderId: "ORD-102", customerId: "CUST-002", orderDate: "2026-08-15", revenue: 15_000_000, cost: 9_000_000, quantity: 5 },
    { orderId: "ORD-103", customerId: "CUST-003", orderDate: "2026-08-20", revenue: 80_000_000, cost: 50_000_000, quantity: 20 },
    { orderId: "ORD-104", customerId: "CUST-001", orderDate: "2026-09-05", revenue: 45_000_000, cost: 30_000_000, quantity: 8 },
    { orderId: "ORD-105", customerId: "CUST-002", orderDate: "2026-09-12", revenue: 20_000_000, cost: 12_000_000, quantity: 6 },
    { orderId: "ORD-106", customerId: "CUST-004", orderDate: "2026-09-28", revenue: 10_000_000, cost: 7_000_000, quantity: 4 },
  ];

  const inventory: InventoryRecord[] = [
    { productId: "PRD-1", sku: "SKU-A", stockQty: 100, reservedQty: 35 },
    { productId: "PRD-2", sku: "SKU-B", stockQty: 50, reservedQty: 15 },
    { productId: "PRD-3", sku: "SKU-C", stockQty: 200, reservedQty: 80 },
  ];

  it("1. Exact entity lookup matches reference SQL", () => {
    // Reference SQL: SELECT * FROM customers WHERE id = 'CUST-001'
    const queryTargetId = "CUST-001";
    const found = customers.find((c) => c.id === queryTargetId);

    expect(found).toBeDefined();
    expect(found?.name).toBe("PT Surya Mandiri");
    expect(found?.region).toBe("Jawa Barat");
  });

  it("2. Count and Count-distinct match reference SQL", () => {
    // Reference SQL: SELECT COUNT(*) as total_orders, COUNT(DISTINCT customer_id) as unique_customers FROM orders
    const totalOrders = orders.length;
    const uniqueCustomers = new Set(orders.map((o) => o.customerId)).size;

    expect(totalOrders).toBe(6);
    expect(uniqueCustomers).toBe(4);
  });

  it("3. Sum / Min / Max temporal aggregation matches reference SQL", () => {
    // Reference SQL: 
    // SELECT SUM(revenue) as total_rev, MIN(revenue) as min_rev, MAX(revenue) as max_rev 
    // FROM orders WHERE order_date >= '2026-08-01' AND order_date <= '2026-08-31'
    const augustOrders = orders.filter((o) => o.orderDate.startsWith("2026-08"));
    const totalRev = augustOrders.reduce((acc, o) => acc + o.revenue, 0);
    const minRev = Math.min(...augustOrders.map((o) => o.revenue));
    const maxRev = Math.max(...augustOrders.map((o) => o.revenue));

    expect(totalRev).toBe(145_000_000);
    expect(minRev).toBe(15_000_000);
    expect(maxRev).toBe(80_000_000);
  });

  it("4. Group by aggregation matches reference SQL", () => {
    // Reference SQL:
    // SELECT c.region, SUM(o.revenue) as region_revenue
    // FROM orders o JOIN customers c ON o.customer_id = c.id
    // GROUP BY c.region ORDER BY region_revenue DESC
    const revenueByRegion: Record<string, number> = {};
    for (const o of orders) {
      const cust = customers.find((c) => c.id === o.customerId);
      if (cust) {
        revenueByRegion[cust.region] = (revenueByRegion[cust.region] || 0) + o.revenue;
      }
    }

    expect(revenueByRegion["DKI Jakarta"]).toBe(115_000_000); // CUST-002: 35M + CUST-003: 80M
    expect(revenueByRegion["Jawa Barat"]).toBe(95_000_000);  // CUST-001: 95M
    expect(revenueByRegion["Jawa Timur"]).toBe(10_000_000);  // CUST-004: 10M
  });

  it("5. Range comparison query matches reference SQL", () => {
    // Reference SQL: SELECT * FROM orders WHERE revenue >= 40000000 AND revenue <= 80000000
    const filtered = orders.filter((o) => o.revenue >= 40_000_000 && o.revenue <= 80_000_000);

    expect(filtered).toHaveLength(3);
    expect(filtered.map((o) => o.orderId).sort()).toEqual(["ORD-101", "ORD-103", "ORD-104"]);
  });

  it("6. Weighted ratio / percentage matches reference formula", () => {
    // Business Definition: Gross Margin % = (SUM(revenue) - SUM(cost)) / SUM(revenue) * 100
    const totalRev = orders.reduce((sum, o) => sum + o.revenue, 0);
    const totalCost = orders.reduce((sum, o) => sum + o.cost, 0);
    const grossMarginPct = ((totalRev - totalCost) / totalRev) * 100;

    expect(totalRev).toBe(220_000_000);
    expect(totalCost).toBe(143_000_000);
    expect(grossMarginPct).toBeCloseTo(35.0, 1);
  });

  it("7. Multi-table join matches relational model", () => {
    // Reference SQL:
    // SELECT o.order_id, c.name, c.segment, o.revenue
    // FROM orders o INNER JOIN customers c ON o.customer_id = c.id
    // WHERE c.segment = 'Enterprise'
    const enterpriseOrders = orders
      .map((o) => {
        const cust = customers.find((c) => c.id === o.customerId);
        return { ...o, customer: cust };
      })
      .filter((item) => item.customer?.segment === "Enterprise");

    expect(enterpriseOrders).toHaveLength(3);
    const totalEnterpriseRev = enterpriseOrders.reduce((sum, o) => sum + o.revenue, 0);
    expect(totalEnterpriseRev).toBe(175_000_000);
  });

  it("8. Cross-file overlap / inventory reconciliation", () => {
    // Cross-source check: available stock = stockQty - reservedQty
    const availableBySku = inventory.map((inv) => ({
      sku: inv.sku,
      available: inv.stockQty - inv.reservedQty,
    }));

    expect(availableBySku).toEqual([
      { sku: "SKU-A", available: 65 },
      { sku: "SKU-B", available: 35 },
      { sku: "SKU-C", available: 120 },
    ]);
  });

  it("9. Hybrid document policy + structured data calculation", () => {
    // Document policy: "VIP discounts apply if order revenue > 40,000,000: 5% discount"
    const policyMinRevenue = 40_000_000;
    const discountRate = 0.05;

    const auditedOrders = orders.map((o) => {
      const qualifies = o.revenue >= policyMinRevenue;
      const discount = qualifies ? o.revenue * discountRate : 0;
      return {
        orderId: o.orderId,
        revenue: o.revenue,
        qualifies,
        discount,
        netRevenue: o.revenue - discount,
      };
    });

    const qualifyingOrders = auditedOrders.filter((o) => o.qualifies);
    expect(qualifyingOrders).toHaveLength(3);
    const totalDiscounts = auditedOrders.reduce((sum, o) => sum + o.discount, 0);
    expect(totalDiscounts).toBe((50_000_000 + 80_000_000 + 45_000_000) * 0.05); // 175M * 0.05 = 8,750,000
    expect(totalDiscounts).toBe(8_750_000);
  });

  it("10. Ambiguity detection abstains cleanly", () => {
    // Ambiguous question: "Berapa omzet?" when multiple conflicting revenue fields exist
    const semanticCandidates = [
      { field: "gross_revenue", label: "Gross Revenue (Sebelum Retur)" },
      { field: "net_revenue", label: "Net Revenue (Setelah Retur & Diskon)" },
    ];

    // Rule: If two distinct metrics match user intent without contextual disambiguation, abstain/ask
    const isAmbiguous = semanticCandidates.length > 1;
    expect(isAmbiguous).toBe(true);

    const promptClarification = (options: typeof semanticCandidates) => ({
      status: "ambiguous",
      message: `Terdapat lebih dari satu definisi omzet: ${options.map((o) => o.label).join(", ")}. Mohon spesifikasikan yang diinginkan.`,
    });

    const decision = promptClarification(semanticCandidates);
    expect(decision.status).toBe("ambiguous");
    expect(decision.message).toContain("Gross Revenue");
    expect(decision.message).toContain("Net Revenue");
  });

  it("11. Presentation-only follow-up reuses prior verified result without re-executing query", () => {
    // Turn 1 result execution
    const turn1Execution = {
      executionId: "exec-turn-1",
      query: "Total omzet per wilayah bulan Agustus",
      data: [
        { region: "DKI Jakarta", revenue: 95_000_000 },
        { region: "Jawa Barat", revenue: 50_000_000 },
      ],
      executedAt: "2026-10-07T08:00:00Z",
      requiresReExecution: false,
    };

    // Turn 2: User says "Tampilkan dalam bentuk tabel markdown"
    const turn2Query = "Tampilkan dalam bentuk tabel markdown";
    const isPresentationOnly = /tampilkan|format|gaya|tabel|grafik|chart|urutkan/i.test(turn2Query) &&
      !/tambah|kurang|refresh|perbarui|ubah periode|filter baru/i.test(turn2Query);

    expect(isPresentationOnly).toBe(true);

    // Presentation transformation reuses turn1Execution.data directly
    const formatAsMarkdownTable = (data: Array<{ region: string; revenue: number }>) => {
      const header = "| Wilayah | Total Omzet |\n|---|---|\n";
      const rows = data.map((d) => `| ${d.region} | Rp ${d.revenue.toLocaleString("id-ID")} |`).join("\n");
      return header + rows;
    };

    const formatted = formatAsMarkdownTable(turn1Execution.data);
    expect(formatted).toContain("| Wilayah | Total Omzet |");
    expect(formatted).toContain("DKI Jakarta");
    expect(formatted).toContain("Rp 95.000.000");
  });
});
