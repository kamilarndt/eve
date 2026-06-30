#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_EVAL_IDS = [
  "sandbox/parallel-revenue-screen",
  "sandbox/parallel-ticket-triage",
  "sandbox/parallel-ticket-triage-80",
  "sandbox/parallel-vendor-risk",
  "sandbox/parallel-workspace-health",
];
const PROMPT_VARIANT_ENV = "EVE_PARALLEL_ACTION_PROMPT_VARIANT";
const PROMPT_VARIANTS = ["control", "treatment"];
const LOOKUP_DELAY_ENV = "EVE_PARALLEL_BENCHMARK_LOOKUP_DELAY_MS";
const COMPARISON_METRICS = [
  {
    compute: (entries) => entries.length,
    format: "integer",
    name: "samples",
  },
  {
    compute: (entries) => avg(entries, (entry) => numberOrZero(entry.metrics.expectedKeyCount)),
    format: "fixed",
    name: "avg_expected_keys",
  },
  {
    compute: (entries) => avg(entries, (entry) => numberOrZero(entry.metrics.coveredKeyCount)),
    format: "fixed",
    name: "avg_covered_keys",
  },
  {
    compute: (entries) => avg(entries, (entry) => missingKeyCount(entry.metrics)),
    format: "fixed",
    name: "avg_missing_keys",
  },
  {
    compute: (entries) => avg(entries, (entry) => numberOrZero(entry.metrics.toolCallCount)),
    format: "fixed",
    name: "avg_tool_calls",
  },
  {
    compute: (entries) => avg(entries, (entry) => numberOrZero(entry.metrics.resultCount)),
    format: "fixed",
    name: "avg_results",
  },
  {
    compute: (entries) => avg(entries, (entry) => batchSizes(entry.metrics).length),
    format: "fixed",
    name: "avg_request_events",
  },
  {
    compute: (entries) => avg(entries, (entry) => meanBatchSize(entry.metrics)),
    format: "fixed",
    name: "avg_batch_size",
  },
  {
    compute: (entries) => avg(entries, (entry) => numberOrZero(entry.metrics.maxBatchSize)),
    format: "fixed",
    name: "avg_max_batch",
  },
  {
    compute: (entries) =>
      avg(entries, (entry) => numberOrZero(entry.metrics.maxObservedConcurrency)),
    format: "fixed",
    name: "avg_max_concurrency",
  },
  {
    compute: (entries) =>
      avg(entries, (entry) => numberOrZero(entry.metrics.avgObservedDurationMs)),
    format: "fixed",
    name: "avg_tool_duration_ms",
  },
  {
    compute: (entries) =>
      avg(entries, (entry) => numberOrZero(entry.metrics.minObservedDurationMs)),
    format: "fixed",
    name: "avg_min_tool_duration_ms",
  },
  {
    compute: (entries) =>
      avg(entries, (entry) => numberOrZero(entry.metrics.maxObservedDurationMs)),
    format: "fixed",
    name: "avg_max_tool_duration_ms",
  },
  {
    compute: (entries) =>
      rate(entries, (entry) => entry.metrics.allRequestsBeforeFirstResult === true),
    format: "percent",
    name: "all_before_first_rate",
  },
  {
    compute: (entries) => rate(entries, (entry) => entry.metrics.allExecutionsOverlap === true),
    format: "percent",
    name: "all_overlap_rate",
  },
  {
    compute: (entries) => avg(entries, (entry) => numberOrZero(entry.metrics.wallClockMs)),
    format: "fixed",
    name: "avg_wall_ms",
  },
];

const fixtureRoot = fileURLToPath(new URL("..", import.meta.url));
const msbHome = process.env.MSB_HOME ?? mkdtempSync("/tmp/eve-parallel-msb-");
const options = parseArgs(process.argv.slice(2));
const variants = selectedVariants(options.variant);
const rng = createRng(options.seed);
const runs = [];

if (options.targetUrl !== undefined && variants.length > 1) {
  throw new Error(
    "--url cannot compare control and treatment because the prompt variant is selected inside the already-running target.",
  );
}

if (process.env.MSB_HOME === undefined) {
  process.stderr.write(`parallel benchmark MSB_HOME=${msbHome}\n`);
}
process.stderr.write(`parallel benchmark seed=${options.seed}\n`);
process.stderr.write(`parallel benchmark jsonl=${options.jsonlPath}\n`);
prepareJsonlFile(options.jsonlPath);

for (let index = 0; index < options.runs; index += 1) {
  const runNumber = index + 1;
  const variantOrder = randomizedVariantOrder(variants, rng);
  for (const variant of variantOrder) {
    process.stderr.write(
      `parallel benchmark run ${runNumber}/${options.runs} variant=${variant}\n`,
    );
    const summary = await runEvalCommand({ ...options, variant });
    const run = collectRun({ runNumber, summary, variant, variantOrder });
    runs.push(run);
    appendJsonlRows(options.jsonlPath, run.rows);
  }
}

const rows = runs.flatMap((run) => run.rows);
const measurements = rows.filter((row) => row.metrics !== null);
printRows(measurements);
printComparison({ measurements, variants });

const failures = runs.flatMap((run) => run.failures);
const expectedMeasurementCount = options.runs * variants.length * options.evalIds.length;
if (measurements.length !== expectedMeasurementCount) {
  process.stderr.write(
    `\nExpected ${expectedMeasurementCount} measurement logs, found ${measurements.length}.\n`,
  );
  process.exitCode = 1;
}

if (failures.length > 0) {
  process.stderr.write("\nEval failures:\n");
  for (const failure of failures) {
    process.stderr.write(
      `- run ${failure.runNumber} ${failure.variant} ${failure.id}: ${failure.error}\n`,
    );
  }
}

function parseArgs(args) {
  const evalIds = [];
  let runs = 1;
  let timeoutMs = 300_000;
  let maxConcurrency = 1;
  let targetUrl;
  let variant = "both";
  let lookupDelayMs;
  let seed = Date.now() >>> 0;
  let jsonlPath;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--runs") {
      runs = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--timeout") {
      timeoutMs = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--max-concurrency") {
      maxConcurrency = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--url") {
      targetUrl = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--variant") {
      variant = readArgValue(args, index, arg);
      if (!["both", ...PROMPT_VARIANTS].includes(variant)) {
        throw new Error(`--variant must be one of: both, ${PROMPT_VARIANTS.join(", ")}`);
      }
      index += 1;
    } else if (arg === "--lookup-delay") {
      lookupDelayMs = parseNonNegativeInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--seed") {
      seed = parseNonNegativeInteger(readArgValue(args, index, arg), arg) >>> 0;
      index += 1;
    } else if (arg === "--jsonl") {
      jsonlPath = resolve(process.cwd(), readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--eval") {
      evalIds.push(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    evalIds: evalIds.length > 0 ? evalIds : DEFAULT_EVAL_IDS,
    jsonlPath: jsonlPath ?? defaultJsonlPath(seed),
    lookupDelayMs,
    maxConcurrency,
    runs,
    seed,
    targetUrl,
    timeoutMs,
    variant,
  };
}

function selectedVariants(variant) {
  return variant === "both" ? PROMPT_VARIANTS : [variant];
}

function randomizedVariantOrder(variantList, rng) {
  if (variantList.length < 2) return variantList;
  const ordered = [...variantList];
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    const current = ordered[index];
    const swap = ordered[swapIndex];
    ordered[index] = swap;
    ordered[swapIndex] = current;
  }
  return ordered;
}

function defaultJsonlPath(seed) {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return join(fixtureRoot, ".eve", "parallel-benchmark", `${timestamp}-seed-${seed}.jsonl`);
}

function prepareJsonlFile(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

function appendJsonlRows(path, rows) {
  if (rows.length === 0) return;
  appendFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function readArgValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer; got "${value}".`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer; got "${value}".`);
  }
  return parsed;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: pnpm benchmark:parallel [options]",
      "",
      "Runs natural parallel-tool evals and compares control/treatment prompt metrics.",
      "",
      "Options:",
      "  --runs <n>             Number of repeated eval runs per variant. Default: 1",
      "  --timeout <ms>         Per-eval timeout passed to eve eval. Default: 300000",
      "  --max-concurrency <n>  Eval-level concurrency passed to eve eval. Default: 1",
      "  --variant <name>       control, treatment, or both. Default: both",
      "  --lookup-delay <ms>    Per-lookup synthetic delay. Default: 3000",
      "  --seed <n>             Seed for randomized variant order. Default: current time",
      "  --jsonl <path>         Raw measurement JSONL path. Default: .eve/parallel-benchmark/*.jsonl",
      "  --eval <id>            Eval id to run. Repeat to run a subset.",
      "  --url <url>            Existing eve target URL. Defaults to a local dev server.",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

async function runEvalCommand(input) {
  const results = [];
  let target = {};

  for (const evalId of input.evalIds) {
    const summary = await runSingleEvalCommand(input, evalId);
    if (isRecord(summary.target)) target = summary.target;

    const result = Array.isArray(summary.results)
      ? (summary.results.find((entry) => isRecord(entry) && entry.id === evalId) ??
        summary.results[0])
      : undefined;
    results.push(
      isRecord(result)
        ? result
        : {
            error: "missing single-eval result",
            id: evalId,
            result: { logs: [] },
            verdict: "failed",
          },
    );
  }

  return { results, target };
}

async function runSingleEvalCommand(input, evalId) {
  const args = [
    "exec",
    "eve",
    "eval",
    evalId,
    "--json",
    "--max-concurrency",
    String(input.maxConcurrency),
    "--timeout",
    String(input.timeoutMs),
  ];

  if (input.targetUrl !== undefined) {
    args.push("--url", input.targetUrl);
  }

  const result = await spawnCapture("pnpm", args, {
    cwd: fixtureRoot,
    lookupDelayMs: input.lookupDelayMs,
    variant: input.variant,
  });
  const summary = parseJsonObject(result.stdout);
  if (summary === undefined) {
    const diagnostic = noSummaryDiagnostic({ evalId, result });
    process.stderr.write(`${diagnostic}\n`);
    return {
      results: [
        {
          error: diagnostic,
          id: evalId,
          result: { logs: [] },
          verdict: "failed",
        },
      ],
      target: {},
    };
  }
  return summary;
}

function spawnCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: createChildEnv(options),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stderr, stdout });
    });
  });
}

function noSummaryDiagnostic(input) {
  return [
    `eve eval did not print a JSON summary for ${input.evalId}.`,
    `exit_code=${input.result.code ?? ""}`,
    `signal=${input.result.signal ?? ""}`,
    `stderr_tail=${JSON.stringify(tailText(input.result.stderr))}`,
    `stdout_tail=${JSON.stringify(tailText(input.result.stdout))}`,
  ].join(" ");
}

function tailText(value) {
  const maxLength = 4_000;
  return value.length <= maxLength ? value : value.slice(-maxLength);
}

function createChildEnv(options) {
  return {
    ...process.env,
    ...(options.lookupDelayMs === undefined
      ? {}
      : { [LOOKUP_DELAY_ENV]: String(options.lookupDelayMs) }),
    [PROMPT_VARIANT_ENV]: options.variant,
    MSB_HOME: msbHome,
  };
}

function parseJsonObject(stdout) {
  for (const start of findSummaryStarts(stdout)) {
    const end = findJsonObjectEnd(stdout, start);
    if (end === undefined) continue;

    try {
      const parsed = JSON.parse(stdout.slice(start, end + 1));
      if (isEvalRunSummary(parsed)) return parsed;
    } catch {
      continue;
    }
  }

  return undefined;
}

function findSummaryStarts(stdout) {
  const starts = [];
  let index = stdout.length;
  while (index > 0) {
    index = stdout.lastIndexOf('{\n  "target"', index - 1);
    if (index === -1) break;
    starts.push(index);
  }
  return starts;
}

function findJsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return undefined;
}

function isEvalRunSummary(value) {
  return isRecord(value) && isRecord(value.target) && Array.isArray(value.results);
}

function collectRun(input) {
  const results = Array.isArray(input.summary.results) ? input.summary.results : [];
  const resultsById = new Map(
    results.map((result) => [typeof result.id === "string" ? result.id : "unknown", result]),
  );
  const rows = [];
  const measurements = [];
  const failures = [];

  for (const evalId of options.evalIds) {
    const result = resultsById.get(evalId);
    const id = result === undefined ? evalId : typeof result.id === "string" ? result.id : evalId;
    if (result === undefined || result.verdict === "failed" || result.error !== undefined) {
      failures.push({
        error:
          result === undefined
            ? "missing eval result"
            : typeof result.error === "string"
              ? result.error
              : "failed eval",
        id,
        runNumber: input.runNumber,
        variant: input.variant,
      });
    }

    const logs = Array.isArray(result?.result?.logs) ? result.result.logs : [];
    const measurement = logs
      .map((log) => parseMeasurement(log))
      .find((entry) => entry !== undefined);
    const row = {
      evalId: id,
      kind: "parallel-benchmark-measurement",
      metrics: measurement?.metrics ?? null,
      measurementPresent: measurement !== undefined,
      runNumber: input.runNumber,
      scenario: measurement?.scenario ?? scenarioFromEvalId(id),
      seed: options.seed,
      variant: input.variant,
      variantOrder: input.variantOrder,
      verdict:
        result === undefined
          ? "missing"
          : typeof result.verdict === "string"
            ? result.verdict
            : "unknown",
    };
    rows.push(row);
    if (row.metrics !== null) measurements.push(row);
  }

  return { failures, measurements, rows };
}

function scenarioFromEvalId(evalId) {
  return (
    evalId
      .split("/")
      .at(-1)
      ?.replace(/^parallel-/, "") ?? evalId
  );
}

function parseMeasurement(log) {
  if (typeof log !== "string") return undefined;

  let parsed;
  try {
    parsed = JSON.parse(log);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  if (parsed.kind !== "natural-parallel-tool-measurement") return undefined;
  if (typeof parsed.scenario !== "string" || !isRecord(parsed.metrics)) return undefined;
  return { metrics: parsed.metrics, scenario: parsed.scenario };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printRows(measurements) {
  process.stdout.write("\nPer run\n");
  process.stdout.write(
    [
      "run",
      "variant",
      "scenario",
      "verdict",
      "calls",
      "max_batch",
      "max_concurrency",
      "avg_tool_ms",
      "all_before_first",
      "all_overlap",
      "wall_ms",
    ].join("\t"),
  );
  process.stdout.write("\n");

  for (const measurement of measurements) {
    const metrics = measurement.metrics;
    process.stdout.write(
      [
        measurement.runNumber,
        measurement.variant,
        measurement.scenario,
        measurement.verdict,
        formatNumber(metrics.toolCallCount),
        formatNumber(metrics.maxBatchSize),
        formatNumber(metrics.maxObservedConcurrency),
        formatNumber(metrics.avgObservedDurationMs),
        formatBoolean(metrics.allRequestsBeforeFirstResult),
        formatBoolean(metrics.allExecutionsOverlap),
        formatNumber(metrics.wallClockMs),
      ].join("\t"),
    );
    process.stdout.write("\n");
  }
}

function printComparison(input) {
  process.stdout.write("\nAggregate comparison\n");
  process.stdout.write(
    ["scenario", "metric", ...input.variants, "delta_treatment_minus_control"].join("\t"),
  );
  process.stdout.write("\n");

  for (const [scenario, entries] of groupByScenario(input.measurements)) {
    const byVariant = groupByVariant(entries);
    for (const metric of COMPARISON_METRICS) {
      const values = new Map(
        input.variants.map((variant) => [variant, metric.compute(byVariant.get(variant) ?? [])]),
      );
      const control = values.get("control");
      const treatment = values.get("treatment");
      const delta =
        control !== undefined && treatment !== undefined
          ? formatMetricDelta(metric, treatment - control)
          : "";
      process.stdout.write(
        [
          scenario,
          metric.name,
          ...input.variants.map((variant) => formatMetricValue(metric, values.get(variant))),
          delta,
        ].join("\t"),
      );
      process.stdout.write("\n");
    }
  }
}

function groupByScenario(measurements) {
  const grouped = new Map();
  for (const measurement of measurements) {
    const entries = grouped.get(measurement.scenario) ?? [];
    entries.push(measurement);
    grouped.set(measurement.scenario, entries);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function groupByVariant(measurements) {
  const grouped = new Map();
  for (const measurement of measurements) {
    const entries = grouped.get(measurement.variant) ?? [];
    entries.push(measurement);
    grouped.set(measurement.variant, entries);
  }
  return grouped;
}

function avg(entries, read) {
  if (entries.length === 0) return 0;
  return entries.reduce((total, entry) => total + read(entry), 0) / entries.length;
}

function rate(entries, read) {
  if (entries.length === 0) return 0;
  return entries.filter(read).length / entries.length;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function missingKeyCount(metrics) {
  if (Array.isArray(metrics.missingKeys)) return metrics.missingKeys.length;
  return Math.max(
    0,
    numberOrZero(metrics.expectedKeyCount) - numberOrZero(metrics.coveredKeyCount),
  );
}

function batchSizes(metrics) {
  return Array.isArray(metrics.batchSizes)
    ? metrics.batchSizes.filter((size) => typeof size === "number" && Number.isFinite(size))
    : [];
}

function meanBatchSize(metrics) {
  const sizes = batchSizes(metrics);
  if (sizes.length === 0) return 0;
  return sizes.reduce((total, size) => total + size, 0) / sizes.length;
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return String(value);
}

function formatFixed(value) {
  return value.toFixed(1);
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function formatBoolean(value) {
  return value === true ? "yes" : value === false ? "no" : "";
}

function formatMetricValue(metric, value) {
  if (value === undefined) return "";
  if (metric.format === "integer") return String(Math.round(value));
  if (metric.format === "percent") return formatPercent(value);
  return formatFixed(value);
}

function formatMetricDelta(metric, value) {
  if (metric.format === "integer") return String(Math.round(value));
  if (metric.format === "percent") return `${Math.round(value * 100)}pp`;
  return formatFixed(value);
}
