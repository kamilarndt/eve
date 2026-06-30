import { defineEval } from "eve/evals";

import {
  expectedToolActionsSucceeded,
  measurementLog,
  requestedEveryKey,
  writtenDsvMatches,
  type DsvConfig,
  type MeasurementConfig,
} from "./parallel-natural.js";

const FILE_PATH = "/workspace/ticket-triage.tsv";
const TICKETS = [
  "TCK-4107",
  "TCK-4188",
  "TCK-4221",
  "TCK-4290",
  "TCK-4312",
  "TCK-4384",
  "TCK-4402",
  "TCK-4475",
] as const;

const MEASUREMENT: MeasurementConfig = {
  expectedKeys: TICKETS,
  keyField: "ticketId",
  toolName: "support-ticket",
};

const DSV: DsvConfig = {
  expectedKeys: TICKETS,
  filePath: FILE_PATH,
  keyColumn: "ticket_id",
  requiredColumns: [
    "ticket_id",
    "customer",
    "severity",
    "product_area",
    "summary",
    "recommended_owner",
    "next_action",
  ],
};

export default defineEval({
  description:
    "Sandbox measurement: natural ticket-triage request over independent support-ticket lookups.",
  tags: ["parallel-benchmark"],
  async test(t) {
    const turn = await t.send(
      [
        "I need a launch-support triage table for these tickets.",
        `Please write ${FILE_PATH} as TSV with columns: ticket_id, customer, severity, product_area, summary, recommended_owner, next_action.`,
        "Use the support-ticket lookup once for each ticket before writing the file.",
        "Keep the lookup calls in this run so I can audit them later; do not delegate chunks to another agent.",
        "There is no existing file to inspect at that path; write the file directly after the lookups.",
        "Tickets:",
        ...TICKETS.map((ticket) => `- ${ticket}`),
      ].join("\n"),
    );
    turn.expectOk();

    t.log(measurementLog({ config: MEASUREMENT, events: turn.events, scenario: "ticket-triage" }));
    t.succeeded();
    t.calledTool("support-ticket", { count: TICKETS.length });
    t.calledTool("write_file", { input: { filePath: FILE_PATH }, count: 1 });
    turn.eventsSatisfy("support ticket lookups and write_file succeeded", (events) =>
      expectedToolActionsSucceeded({ events, toolNames: ["support-ticket", "write_file"] }),
    );
    turn.eventsSatisfy("every support ticket was requested", (events) =>
      requestedEveryKey({ config: MEASUREMENT, events }),
    );
    turn.eventsSatisfy("written ticket TSV has one valid row per ticket", (events) =>
      writtenDsvMatches({ config: DSV, events }),
    );
  },
});
