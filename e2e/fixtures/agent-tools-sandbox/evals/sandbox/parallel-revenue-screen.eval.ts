import { defineEval } from "eve/evals";

import {
  expectedToolActionsSucceeded,
  measurementLog,
  requestedEveryKey,
  writtenDsvMatches,
  type DsvConfig,
  type MeasurementConfig,
} from "./parallel-natural.js";

const FILE_PATH = "/workspace/revenue-screen.tsv";
const COMPANIES = [
  "Apple",
  "Microsoft",
  "Alphabet",
  "Amazon",
  "Nvidia",
  "Meta",
  "Berkshire Hathaway",
  "Tesla",
  "Walmart",
  "JPMorgan Chase",
  "Exxon Mobil",
  "UnitedHealth Group",
] as const;

const MEASUREMENT: MeasurementConfig = {
  expectedKeys: COMPANIES,
  keyField: "company",
  toolName: "company-revenue",
};

const DSV: DsvConfig = {
  expectedKeys: COMPANIES,
  filePath: FILE_PATH,
  keyColumn: "company",
  numericColumns: ["fiscal_year", "revenue_usd_millions"],
  requiredColumns: [
    "company",
    "ticker",
    "fiscal_year",
    "revenue_usd_millions",
    "source",
    "bull_case",
    "bear_case",
  ],
};

export default defineEval({
  description:
    "Sandbox measurement: natural revenue-screen request over independent company lookups.",
  tags: ["parallel-benchmark"],
  async test(t) {
    const turn = await t.send(
      [
        "Can you put together a revenue screen for the companies below?",
        `Please write it to ${FILE_PATH} as a tab-separated file with columns: company, ticker, fiscal_year, revenue_usd_millions, source, bull_case, bear_case.`,
        "Use the company-revenue lookup once for each company before writing the file.",
        "Keep the lookup calls in this run so I can audit them later; do not delegate chunks to another agent.",
        "There is no existing file to inspect at that path; write the file directly after the lookups.",
        "Companies:",
        ...COMPANIES.map((company) => `- ${company}`),
      ].join("\n"),
    );
    turn.expectOk();

    t.log(measurementLog({ config: MEASUREMENT, events: turn.events, scenario: "revenue-screen" }));
    t.succeeded();
    t.calledTool("company-revenue", { count: COMPANIES.length });
    t.calledTool("write_file", { input: { filePath: FILE_PATH }, count: 1 });
    turn.eventsSatisfy("company revenue lookups and write_file succeeded", (events) =>
      expectedToolActionsSucceeded({ events, toolNames: ["company-revenue", "write_file"] }),
    );
    turn.eventsSatisfy("every company lookup was requested", (events) =>
      requestedEveryKey({ config: MEASUREMENT, events }),
    );
    turn.eventsSatisfy("written revenue TSV has one valid row per company", (events) =>
      writtenDsvMatches({ config: DSV, events }),
    );
  },
});
