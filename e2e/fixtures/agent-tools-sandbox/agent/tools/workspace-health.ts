import { defineTool } from "eve/tools";
import { z } from "zod";

import { delay, parallelBenchmarkLookupDelayMs } from "../../support/parallel-benchmark-delay.js";

const FIRST_WORKSPACE_NUMBER = 2001;
const WORKSPACE_COUNT = 80;

const CUSTOMER_TIERS = ["enterprise", "growth", "strategic", "startup"] as const;
const STATUSES = ["ready", "watch", "blocked", "review"] as const;
const RISK_AREAS = [
  "billing export",
  "identity sync",
  "webhook delivery",
  "data residency",
  "audit logging",
  "workflow queue",
  "notification routing",
  "role mapping",
] as const;

function workspaceOffset(workspaceId: string): number | undefined {
  const match = /^WS-(\d{4})$/u.exec(workspaceId.trim());
  if (match === null) return undefined;

  const rawNumber = match[1];
  if (rawNumber === undefined) return undefined;

  const workspaceNumber = Number(rawNumber);
  if (!Number.isInteger(workspaceNumber)) return undefined;

  const offset = workspaceNumber - FIRST_WORKSPACE_NUMBER;
  return offset >= 0 && offset < WORKSPACE_COUNT ? offset : undefined;
}

export default defineTool({
  description:
    "Fetch one workspace's launch-readiness health score, status, risk area, customer tier, and recommended action. Use this when the user asks for workspace launch audits, readiness tables, or customer health screens.",
  inputSchema: z.object({
    workspaceId: z.string().describe("Workspace id, such as WS-2001."),
  }),
  async execute({ workspaceId }) {
    const executionStartedAt = Date.now();
    await delay(parallelBenchmarkLookupDelayMs());

    const offset = workspaceOffset(workspaceId);
    if (offset === undefined) {
      throw new Error(`No workspace-health fixture available for "${workspaceId}".`);
    }

    const riskArea = RISK_AREAS[offset % RISK_AREAS.length];
    const status = STATUSES[(offset * 3) % STATUSES.length];
    const healthScore = 54 + ((offset * 7) % 45);
    const customerTier = CUSTOMER_TIERS[(offset * 5) % CUSTOMER_TIERS.length];

    return {
      customerTier,
      healthScore,
      recommendedAction: `Review ${riskArea} controls before launch window ${1 + (offset % 4)}.`,
      riskArea,
      status,
      workspaceId: `WS-${String(FIRST_WORKSPACE_NUMBER + offset).padStart(4, "0")}`,
      executionCompletedAt: Date.now(),
      executionStartedAt,
    };
  },
});
