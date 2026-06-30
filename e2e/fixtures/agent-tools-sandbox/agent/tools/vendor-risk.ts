import { defineTool } from "eve/tools";
import { z } from "zod";

import { delay, parallelBenchmarkLookupDelayMs } from "../../support/parallel-benchmark-delay.js";

const VENDORS = [
  {
    criticality: "high",
    mitigation: "Require SOC 2 bridge letter and quarterly access review.",
    primaryRisk: "Privileged production access",
    renewalWindow: "2026-Q3",
    riskScore: 86,
    vendor: "Acme Observability",
  },
  {
    criticality: "medium",
    mitigation: "Move API key rotation to 60-day cadence.",
    primaryRisk: "Long-lived integration credentials",
    renewalWindow: "2026-Q2",
    riskScore: 71,
    vendor: "Beacon CRM",
  },
  {
    criticality: "high",
    mitigation: "Negotiate regional processing addendum before renewal.",
    primaryRisk: "Cross-region customer data processing",
    renewalWindow: "2026-Q4",
    riskScore: 82,
    vendor: "CloudLedger",
  },
  {
    criticality: "low",
    mitigation: "Keep on standard procurement review.",
    primaryRisk: "Limited operational dependency",
    renewalWindow: "2026-Q1",
    riskScore: 38,
    vendor: "Draftly",
  },
  {
    criticality: "medium",
    mitigation: "Add backup export path and test restore quarterly.",
    primaryRisk: "Single export path for finance records",
    renewalWindow: "2026-Q3",
    riskScore: 67,
    vendor: "ExpenseForge",
  },
  {
    criticality: "high",
    mitigation: "Require incident notification SLA under 24 hours.",
    primaryRisk: "Security event notification lag",
    renewalWindow: "2026-Q2",
    riskScore: 79,
    vendor: "ForgeDeploy",
  },
  {
    criticality: "medium",
    mitigation: "Restrict scopes and monitor unusual search volume.",
    primaryRisk: "Broad employee directory read access",
    renewalWindow: "2026-Q4",
    riskScore: 64,
    vendor: "GraphPeople",
  },
  {
    criticality: "low",
    mitigation: "Keep annual review; no extra controls needed.",
    primaryRisk: "Non-sensitive analytics metadata",
    renewalWindow: "2026-Q1",
    riskScore: 31,
    vendor: "Harbor Metrics",
  },
] as const;

const LOOKUP = new Map(VENDORS.map((vendor) => [vendor.vendor.toLowerCase(), vendor]));

export default defineTool({
  description:
    "Look up one vendor's risk score, primary risk, criticality, renewal window, and mitigation. Use this when the user asks for vendor-risk reviews, procurement risk summaries, or renewal risk tables.",
  inputSchema: z.object({
    vendor: z.string().describe("Vendor name to look up."),
  }),
  async execute({ vendor }) {
    const executionStartedAt = Date.now();
    await delay(parallelBenchmarkLookupDelayMs());

    const row = LOOKUP.get(vendor.trim().toLowerCase());
    if (row === undefined) {
      throw new Error(`No vendor-risk fixture available for "${vendor}".`);
    }

    return { ...row, executionCompletedAt: Date.now(), executionStartedAt };
  },
});
