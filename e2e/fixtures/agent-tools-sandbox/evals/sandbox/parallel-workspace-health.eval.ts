import { defineEval } from "eve/evals";

import {
  expectedToolActionsSucceeded,
  measurementLog,
  requestedEveryKey,
  writtenDsvMatches,
  type DsvConfig,
  type MeasurementConfig,
} from "./parallel-natural.js";

const FILE_PATH = "/workspace/workspace-health.tsv";
const WORKSPACE_IDS = Array.from(
  { length: 80 },
  (_, index) => `WS-${String(2001 + index).padStart(4, "0")}`,
);

const MEASUREMENT: MeasurementConfig = {
  expectedKeys: WORKSPACE_IDS,
  keyField: "workspaceId",
  toolName: "workspace-health",
};

const DSV: DsvConfig = {
  expectedKeys: WORKSPACE_IDS,
  filePath: FILE_PATH,
  keyColumn: "workspace_id",
  numericColumns: ["health_score"],
  requiredColumns: [
    "workspace_id",
    "customer_tier",
    "health_score",
    "status",
    "risk_area",
    "recommended_action",
  ],
};

export default defineEval({
  description:
    "Sandbox measurement: natural workspace-health request over 80 independent workspace lookups.",
  tags: ["parallel-benchmark"],
  timeoutMs: 300_000,
  async test(t) {
    const turn = await t.send(
      [
        "Can you build a launch-readiness health table for these customer workspaces?",
        `Write ${FILE_PATH} as TSV with columns: workspace_id, customer_tier, health_score, status, risk_area, recommended_action.`,
        "Use the workspace-health lookup once for each workspace before writing the file.",
        "Keep the lookup calls in this run so I can audit them later; do not delegate chunks to another agent.",
        "There is no existing file to inspect at that path; write the file directly after the lookups.",
        "Workspaces:",
        ...WORKSPACE_IDS.map((workspaceId) => `- ${workspaceId}`),
      ].join("\n"),
    );
    turn.expectOk();

    t.log(
      measurementLog({ config: MEASUREMENT, events: turn.events, scenario: "workspace-health-80" }),
    );
    t.succeeded();
    t.calledTool("workspace-health", { count: WORKSPACE_IDS.length });
    t.calledTool("write_file", { input: { filePath: FILE_PATH }, count: 1 });
    turn.eventsSatisfy("workspace health lookups and write_file succeeded", (events) =>
      expectedToolActionsSucceeded({ events, toolNames: ["workspace-health", "write_file"] }),
    );
    turn.eventsSatisfy("every workspace lookup was requested", (events) =>
      requestedEveryKey({ config: MEASUREMENT, events }),
    );
    turn.eventsSatisfy("written workspace health TSV has one valid row per workspace", (events) =>
      writtenDsvMatches({ config: DSV, events }),
    );
  },
});
