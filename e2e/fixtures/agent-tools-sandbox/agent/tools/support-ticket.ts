import { defineTool } from "eve/tools";
import { z } from "zod";

import { delay, parallelBenchmarkLookupDelayMs } from "../../support/parallel-benchmark-delay.js";

const FIRST_GENERATED_TICKET_NUMBER = 5001;
const GENERATED_TICKET_COUNT = 80;

const GENERATED_CUSTOMERS = [
  "Northstar Bank",
  "Juniper Health",
  "Redwood Logistics",
  "Aster Studio",
  "Helio Grid",
  "Meridian Retail",
  "Cobalt AI",
  "Prairie Legal",
] as const;
const GENERATED_NEXT_ACTIONS = [
  "Confirm owner and publish the customer-facing update.",
  "Patch the guardrail and add a regression check.",
  "Escalate to the owning team with reproduction notes.",
  "Verify the retry path and document rollback steps.",
  "Backfill telemetry and notify the launch channel.",
  "Add a temporary rate limit and schedule a follow-up review.",
  "Pin the affected configuration and capture support notes.",
  "Prepare the customer workaround and assign a launch owner.",
] as const;
const GENERATED_PRODUCT_AREAS = [
  "webhooks",
  "oauth",
  "durable queues",
  "dashboard",
  "telemetry",
  "catalog sync",
  "model routing",
  "data retention",
] as const;
const GENERATED_SEVERITIES = ["high", "medium", "medium", "low"] as const;
const GENERATED_SUMMARIES = [
  "Launch blocker needs owner confirmation.",
  "Customer reports inconsistent behavior during rollout.",
  "Readiness check found a missing operational guardrail.",
  "Support handoff needs a concrete next action.",
  "Escalation path is unclear for the launch window.",
  "Customer-facing workflow needs validation before release.",
  "Observed retry behavior differs from expected policy.",
  "Account-specific configuration requires final review.",
] as const;

const TICKETS = [
  {
    customer: "Northstar Bank",
    nextAction: "Confirm webhook retry window and apply idempotency patch.",
    owner: "platform",
    productArea: "webhooks",
    severity: "high",
    summary: "Duplicate settlement webhook after provider retry.",
    ticketId: "TCK-4107",
  },
  {
    customer: "Juniper Health",
    nextAction: "Add guardrail copy and return invalid scope details.",
    owner: "auth",
    productArea: "oauth",
    severity: "medium",
    summary: "OAuth consent loops when a user denies optional scopes.",
    ticketId: "TCK-4188",
  },
  {
    customer: "Redwood Logistics",
    nextAction: "Raise queue visibility timeout and emit retry metric.",
    owner: "workflow",
    productArea: "durable queues",
    severity: "high",
    summary: "Long-running export resumes twice after worker restart.",
    ticketId: "TCK-4221",
  },
  {
    customer: "Aster Studio",
    nextAction: "Patch markdown sanitizer and add regression fixture.",
    owner: "frontend",
    productArea: "dashboard",
    severity: "low",
    summary: "Escaped table pipes render incorrectly in audit view.",
    ticketId: "TCK-4290",
  },
  {
    customer: "Helio Grid",
    nextAction: "Backfill run attributes and document missing dimensions.",
    owner: "observability",
    productArea: "telemetry",
    severity: "medium",
    summary: "Run detail page omits model tag on resumed steps.",
    ticketId: "TCK-4312",
  },
  {
    customer: "Meridian Retail",
    nextAction: "Throttle bulk imports and expose progress checkpoint.",
    owner: "integrations",
    productArea: "catalog sync",
    severity: "medium",
    summary: "Bulk product import exceeds vendor API rate limits.",
    ticketId: "TCK-4384",
  },
  {
    customer: "Cobalt AI",
    nextAction: "Pin model routing and report fallback reason in logs.",
    owner: "ai-runtime",
    productArea: "model routing",
    severity: "high",
    summary: "Fallback model ignores configured tool-output schema.",
    ticketId: "TCK-4402",
  },
  {
    customer: "Prairie Legal",
    nextAction: "Add retention override preview and require admin approval.",
    owner: "compliance",
    productArea: "data retention",
    severity: "low",
    summary: "Tenant admin wants to preview retention-rule impact.",
    ticketId: "TCK-4475",
  },
] as const;

const LOOKUP = new Map(TICKETS.map((ticket) => [ticket.ticketId.toLowerCase(), ticket]));

function generatedTicketOffset(ticketId: string): number | undefined {
  const match = /^TCK-(\d{4})$/u.exec(ticketId.trim());
  if (match === null) return undefined;

  const rawNumber = match[1];
  if (rawNumber === undefined) return undefined;

  const ticketNumber = Number(rawNumber);
  if (!Number.isInteger(ticketNumber)) return undefined;

  const offset = ticketNumber - FIRST_GENERATED_TICKET_NUMBER;
  return offset >= 0 && offset < GENERATED_TICKET_COUNT ? offset : undefined;
}

function generatedTicket(ticketId: string) {
  const offset = generatedTicketOffset(ticketId);
  if (offset === undefined) return undefined;

  const customer = GENERATED_CUSTOMERS[offset % GENERATED_CUSTOMERS.length] ?? "Northstar Bank";
  const nextAction =
    GENERATED_NEXT_ACTIONS[offset % GENERATED_NEXT_ACTIONS.length] ??
    "Confirm owner and publish the customer-facing update.";
  const owner =
    GENERATED_PRODUCT_AREAS[(offset * 3) % GENERATED_PRODUCT_AREAS.length] ?? "platform";
  const productArea =
    GENERATED_PRODUCT_AREAS[offset % GENERATED_PRODUCT_AREAS.length] ?? "webhooks";
  const severity = GENERATED_SEVERITIES[offset % GENERATED_SEVERITIES.length] ?? "medium";
  const summary =
    GENERATED_SUMMARIES[offset % GENERATED_SUMMARIES.length] ??
    "Support handoff needs a concrete next action.";

  return {
    customer,
    nextAction,
    owner,
    productArea,
    severity,
    summary,
    ticketId: `TCK-${String(FIRST_GENERATED_TICKET_NUMBER + offset).padStart(4, "0")}`,
  };
}

export default defineTool({
  description:
    "Fetch one support ticket's customer, severity, product area, summary, recommended owner, and next action. Use this when the user asks to triage support tickets or build an escalation table.",
  inputSchema: z.object({
    ticketId: z.string().describe("Support ticket id, such as TCK-4107."),
  }),
  async execute({ ticketId }) {
    const executionStartedAt = Date.now();
    await delay(parallelBenchmarkLookupDelayMs());

    const ticket = LOOKUP.get(ticketId.trim().toLowerCase()) ?? generatedTicket(ticketId);
    if (ticket === undefined) {
      throw new Error(`No support-ticket fixture available for "${ticketId}".`);
    }

    return { ...ticket, executionCompletedAt: Date.now(), executionStartedAt };
  },
});
