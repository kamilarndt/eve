import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [artifactRoot, format] = process.argv.slice(2);

if (artifactRoot === undefined) {
  throw new Error(
    "Usage: node scripts/summarize-tool-execution-latency.mjs <artifact-root> [markdown]",
  );
}
if (format !== undefined && format !== "markdown") {
  throw new Error(`Unknown output format: ${format}`);
}

const traces = await readTraces(resolve(artifactRoot));
if (traces.length === 0) {
  throw new Error(`No tool-execution timing traces found under ${artifactRoot}.`);
}

const summary = {
  kinds: [...new Set(traces.map((trace) => trace.kind))],
  metrics: summarizeMetrics(traces),
  trials: traces.map((trace) => ({
    kind: trace.kind,
    source: trace.source,
    timing: trace.timing,
    trial: trace.trial,
  })),
};

await writeOutput(
  format === "markdown" ? renderMarkdown(summary) : `${JSON.stringify(summary, null, 2)}\n`,
);

async function readTraces(root) {
  const files = await findJsonFiles(root);
  const traces = [];

  for (const file of files) {
    const payload = parseJsonDocument(await readFile(file, "utf8"));
    if (!isRecord(payload)) continue;
    const logs = payload?.result?.logs;
    if (!Array.isArray(logs)) continue;

    for (const log of logs) {
      if (typeof log !== "string") continue;
      const trace = parseTrace(log);
      if (trace === undefined) continue;
      traces.push({
        kind: trace.kind,
        source: file,
        timing: trace.timing,
        trial: trialFromPath(file),
      });
    }
  }

  return traces.sort((left, right) => left.trial.localeCompare(right.trial));
}

async function findJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return await findJsonFiles(path);
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    }),
  );
  return nested.flat();
}

function parseTrace(value) {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed) || !isRecord(parsed.timing) || typeof parsed.kind !== "string") {
      return undefined;
    }
    if (parsed.kind !== "tool-fanout-trace" && parsed.kind !== "bash-curl-latency-trace") {
      return undefined;
    }
    return { kind: parsed.kind, timing: parsed.timing };
  } catch {
    return undefined;
  }
}

function parseJsonDocument(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function summarizeMetrics(traces) {
  const valuesByMetric = new Map();
  for (const trace of traces) {
    for (const [name, value] of Object.entries(trace.timing)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const values = valuesByMetric.get(name) ?? [];
      values.push(value);
      valuesByMetric.set(name, values);
    }
  }

  return Object.fromEntries(
    [...valuesByMetric.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, values]) => [name, summarize(values)]),
  );
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    max: sorted.at(-1),
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted, percentileValue) {
  return sorted[Math.ceil(percentileValue * sorted.length) - 1];
}

function renderMarkdown(summary) {
  const rows = Object.entries(summary.metrics)
    .map(
      ([metric, value]) =>
        `| ${metric} | ${value.count} | ${value.p50} | ${value.p95} | ${value.min} | ${value.max} |`,
    )
    .join("\n");

  return [
    "## Tool execution latency",
    "",
    `Trace kinds: ${summary.kinds.join(", ")}`,
    "",
    "| Metric (ms) | n | p50 | p95 | min | max |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    rows,
    "",
    "p95 uses nearest-rank. `estimatedEager*` and `potential*` are counterfactual estimates; compare `current*` directly between baseline and treatment.",
    "",
  ].join("\n");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trialFromPath(path) {
  return path.split("/").find((segment) => segment.startsWith("trial-")) ?? "unknown";
}

async function writeOutput(value) {
  await new Promise((resolve, reject) => {
    process.stdout.write(value, (error) => (error == null ? resolve() : reject(error)));
  });
}
