import { defineEval } from "eve/evals";

import {
  expectedToolActionsSucceeded,
  measurementLog,
  requestedEveryKey,
  writtenDsvMatches,
  type DsvConfig,
  type MeasurementConfig,
} from "./parallel-natural.js";

const FILE_PATH = "/workspace/vendor-risk.tsv";
const VENDORS = [
  "Acme Observability",
  "Beacon CRM",
  "CloudLedger",
  "Draftly",
  "ExpenseForge",
  "ForgeDeploy",
  "GraphPeople",
  "Harbor Metrics",
] as const;

const MEASUREMENT: MeasurementConfig = {
  expectedKeys: VENDORS,
  keyField: "vendor",
  toolName: "vendor-risk",
};

const DSV: DsvConfig = {
  expectedKeys: VENDORS,
  filePath: FILE_PATH,
  keyColumn: "vendor",
  numericColumns: ["risk_score"],
  requiredColumns: [
    "vendor",
    "risk_score",
    "criticality",
    "primary_risk",
    "renewal_window",
    "mitigation",
  ],
};

export default defineEval({
  description: "Sandbox measurement: natural vendor-risk request over independent vendor lookups.",
  tags: ["parallel-benchmark"],
  async test(t) {
    const turn = await t.send(
      [
        "Can you make a vendor risk shortlist for procurement?",
        `Write ${FILE_PATH} as TSV with columns: vendor, risk_score, criticality, primary_risk, renewal_window, mitigation.`,
        "Use the vendor-risk lookup once for each vendor before writing the file.",
        "Keep the lookup calls in this run so I can audit them later; do not delegate chunks to another agent.",
        "There is no existing file to inspect at that path; write the file directly after the lookups.",
        "Vendors:",
        ...VENDORS.map((vendor) => `- ${vendor}`),
      ].join("\n"),
    );
    turn.expectOk();

    t.log(measurementLog({ config: MEASUREMENT, events: turn.events, scenario: "vendor-risk" }));
    t.succeeded();
    t.calledTool("vendor-risk", { count: VENDORS.length });
    t.calledTool("write_file", { input: { filePath: FILE_PATH }, count: 1 });
    turn.eventsSatisfy("vendor risk lookups and write_file succeeded", (events) =>
      expectedToolActionsSucceeded({ events, toolNames: ["vendor-risk", "write_file"] }),
    );
    turn.eventsSatisfy("every vendor lookup was requested", (events) =>
      requestedEveryKey({ config: MEASUREMENT, events }),
    );
    turn.eventsSatisfy("written vendor TSV has one valid row per vendor", (events) =>
      writtenDsvMatches({ config: DSV, events }),
    );
  },
});
