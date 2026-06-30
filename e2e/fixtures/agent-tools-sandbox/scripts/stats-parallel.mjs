#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT_VARIANTS = ["control", "treatment"];
const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
const DEFAULT_SEED = 12_345;

const BINARY_METRICS = [
  {
    name: "full_parallel",
    read: (row) => {
      const metrics = row.metrics;
      if (!isRecord(metrics)) return false;
      const expectedKeyCount = finiteNumber(metrics.expectedKeyCount);
      return (
        expectedKeyCount !== undefined &&
        finiteNumber(metrics.coveredKeyCount) === expectedKeyCount &&
        finiteNumber(metrics.resultCount) === expectedKeyCount &&
        metrics.allRequestsBeforeFirstResult === true &&
        metrics.allExecutionsOverlap === true
      );
    },
  },
  {
    name: "verdict_passed",
    read: (row) => row.verdict === "passed",
  },
];

const CONTINUOUS_METRICS = [
  {
    name: "concurrency_ratio",
    read: (row) => {
      const metrics = row.metrics;
      if (!isRecord(metrics)) return undefined;
      const expectedKeyCount = finiteNumber(metrics.expectedKeyCount);
      const maxObservedConcurrency = finiteNumber(metrics.maxObservedConcurrency);
      if (expectedKeyCount === undefined || expectedKeyCount === 0) return undefined;
      if (maxObservedConcurrency === undefined) return undefined;
      return maxObservedConcurrency / expectedKeyCount;
    },
  },
  {
    name: "coverage_rate",
    read: (row) => {
      const metrics = row.metrics;
      if (!isRecord(metrics)) return undefined;
      const expectedKeyCount = finiteNumber(metrics.expectedKeyCount);
      const coveredKeyCount = finiteNumber(metrics.coveredKeyCount);
      if (expectedKeyCount === undefined || expectedKeyCount === 0) return undefined;
      if (coveredKeyCount === undefined) return undefined;
      return coveredKeyCount / expectedKeyCount;
    },
  },
  {
    name: "wall_ms",
    read: (row) => (isRecord(row.metrics) ? finiteNumber(row.metrics.wallClockMs) : undefined),
  },
  {
    name: "avg_tool_duration_ms",
    read: (row) =>
      isRecord(row.metrics) ? finiteNumber(row.metrics.avgObservedDurationMs) : undefined,
  },
];

const fixtureRoot = fileURLToPath(new URL("..", import.meta.url));
const options = parseArgs(process.argv.slice(2));
let output = "";
const rows = readRows(options.inputPath);
const pairsByScenario = pairedRowsByScenario(rows);
const rng = createRng(options.seed);

emit(`input\t${options.inputDisplayPath}\n`);
emit(`bootstrap_iterations\t${options.bootstrapIterations}\n`);
emit(`seed\t${options.seed}\n`);

printBinaryStats(pairsByScenario);
printContinuousStats(pairsByScenario, {
  bootstrapIterations: options.bootstrapIterations,
  rng,
});
writeOutputArtifact(options.outputPath);

function parseArgs(args) {
  let inputPath;
  let inputDisplayPath;
  let outputPath;
  let bootstrapIterations = DEFAULT_BOOTSTRAP_ITERATIONS;
  let seed = DEFAULT_SEED;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--input") {
      inputDisplayPath = readArgValue(args, index, arg);
      inputPath = resolve(process.cwd(), inputDisplayPath);
      index += 1;
    } else if (arg === "--output") {
      outputPath = resolve(process.cwd(), readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--bootstrap") {
      bootstrapIterations = parsePositiveInteger(readArgValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--seed") {
      seed = parseNonNegativeInteger(readArgValue(args, index, arg), arg) >>> 0;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const resolvedInputPath = inputPath ?? latestJsonlPath();

  return {
    bootstrapIterations,
    inputDisplayPath: inputDisplayPath ?? relative(process.cwd(), resolvedInputPath),
    inputPath: resolvedInputPath,
    outputPath,
    seed,
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
      "Usage: pnpm stats:parallel [options]",
      "",
      "Computes paired control/treatment statistics from benchmark JSONL.",
      "",
      "Options:",
      "  --input <path>       Raw JSONL path. Default: latest .eve/parallel-benchmark/*.jsonl",
      "  --output <path>      Write the printed statistics table to this path.",
      "  --bootstrap <n>      Bootstrap/permutation iterations. Default: 10000",
      "  --seed <n>           Random seed for bootstrap/permutation. Default: 12345",
    ].join("\n"),
  );
  process.stdout.write("\n");
}

function latestJsonlPath() {
  const directory = join(fixtureRoot, ".eve", "parallel-benchmark");
  const latest = readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .at(-1);
  if (latest === undefined) {
    throw new Error(`No benchmark JSONL files found in ${directory}.`);
  }
  return join(directory, latest);
}

function readRows(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
    .filter((row) => isRecord(row) && row.kind === "parallel-benchmark-measurement");
}

function pairedRowsByScenario(rows) {
  const scenarios = new Map();

  for (const row of rows) {
    if (typeof row.scenario !== "string") continue;
    if (typeof row.runNumber !== "number") continue;
    if (!PROMPT_VARIANTS.includes(row.variant)) continue;

    const scenarioRuns = scenarios.get(row.scenario) ?? new Map();
    const run = scenarioRuns.get(row.runNumber) ?? {};
    run[row.variant] = row;
    scenarioRuns.set(row.runNumber, run);
    scenarios.set(row.scenario, scenarioRuns);
  }

  return [...scenarios.entries()]
    .map(([scenario, runMap]) => ({
      pairs: [...runMap.entries()]
        .sort(([left], [right]) => left - right)
        .flatMap(([, pair]) =>
          pair.control !== undefined && pair.treatment !== undefined ? [pair] : [],
        ),
      scenario,
    }))
    .sort((left, right) => left.scenario.localeCompare(right.scenario));
}

function printBinaryStats(groups) {
  emit("\nBinary paired tests\n");
  emit(
    [
      "scenario",
      "metric",
      "pairs",
      "control_rate",
      "treatment_rate",
      "delta",
      "treatment_wins",
      "control_wins",
      "p_exact_sign",
    ].join("\t"),
  );
  emit("\n");

  for (const group of groups) {
    for (const metric of BINARY_METRICS) {
      const stats = binaryPairedStats(group.pairs, metric.read);
      emit(
        [
          group.scenario,
          metric.name,
          stats.pairs,
          formatPercent(stats.controlRate),
          formatPercent(stats.treatmentRate),
          formatPercent(stats.delta),
          stats.treatmentWins,
          stats.controlWins,
          formatPValue(stats.pValue),
        ].join("\t"),
      );
      emit("\n");
    }
  }
}

function printContinuousStats(groups, options) {
  emit("\nContinuous paired tests\n");
  emit(
    [
      "scenario",
      "metric",
      "pairs",
      "control_mean",
      "treatment_mean",
      "mean_delta",
      "median_delta",
      "ci95_low",
      "ci95_high",
      "p_permutation",
    ].join("\t"),
  );
  emit("\n");

  for (const group of groups) {
    for (const metric of CONTINUOUS_METRICS) {
      const stats = continuousPairedStats(group.pairs, metric.read, options);
      emit(
        [
          group.scenario,
          metric.name,
          stats.pairs,
          formatNumber(stats.controlMean),
          formatNumber(stats.treatmentMean),
          formatNumber(stats.meanDelta),
          formatNumber(stats.medianDelta),
          formatNumber(stats.ci95Low),
          formatNumber(stats.ci95High),
          formatPValue(stats.pValue),
        ].join("\t"),
      );
      emit("\n");
    }
  }
}

function emit(text) {
  output += text;
  process.stdout.write(text);
}

function writeOutputArtifact(path) {
  if (path === undefined) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, output);
}

function binaryPairedStats(pairs, read) {
  let controlTrue = 0;
  let treatmentTrue = 0;
  let treatmentWins = 0;
  let controlWins = 0;

  for (const pair of pairs) {
    const control = read(pair.control);
    const treatment = read(pair.treatment);
    if (control) controlTrue += 1;
    if (treatment) treatmentTrue += 1;
    if (treatment && !control) treatmentWins += 1;
    if (control && !treatment) controlWins += 1;
  }

  return {
    controlRate: pairs.length === 0 ? 0 : controlTrue / pairs.length,
    controlWins,
    delta: pairs.length === 0 ? 0 : (treatmentTrue - controlTrue) / pairs.length,
    pValue: exactTwoSidedSignPValue(treatmentWins, controlWins),
    pairs: pairs.length,
    treatmentRate: pairs.length === 0 ? 0 : treatmentTrue / pairs.length,
    treatmentWins,
  };
}

function continuousPairedStats(pairs, read, options) {
  const complete = pairs.flatMap((pair) => {
    const control = read(pair.control);
    const treatment = read(pair.treatment);
    if (control === undefined || treatment === undefined) return [];
    return [{ control, delta: treatment - control, treatment }];
  });
  const deltas = complete.map((entry) => entry.delta);
  const ci = bootstrapMeanDeltaCi(deltas, options);

  return {
    ci95High: ci.high,
    ci95Low: ci.low,
    controlMean: mean(complete.map((entry) => entry.control)),
    meanDelta: mean(deltas),
    medianDelta: median(deltas),
    pValue: pairedPermutationPValue(deltas, options),
    pairs: complete.length,
    treatmentMean: mean(complete.map((entry) => entry.treatment)),
  };
}

function exactTwoSidedSignPValue(treatmentWins, controlWins) {
  const discordant = treatmentWins + controlWins;
  if (discordant === 0) return 1;
  const extreme = Math.min(treatmentWins, controlWins);
  let term = 2 ** -discordant;
  let cumulative = term;
  for (let index = 0; index < extreme; index += 1) {
    term *= (discordant - index) / (index + 1);
    cumulative += term;
  }
  return Math.min(1, 2 * cumulative);
}

function bootstrapMeanDeltaCi(deltas, options) {
  if (deltas.length === 0) return { high: undefined, low: undefined };
  const samples = [];
  for (let iteration = 0; iteration < options.bootstrapIterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      total += deltas[Math.floor(options.rng() * deltas.length)] ?? 0;
    }
    samples.push(total / deltas.length);
  }
  samples.sort((left, right) => left - right);
  return {
    high: samples[Math.floor((samples.length - 1) * 0.975)],
    low: samples[Math.floor((samples.length - 1) * 0.025)],
  };
}

function pairedPermutationPValue(deltas, options) {
  if (deltas.length === 0) return undefined;
  const observed = Math.abs(mean(deltas));
  if (observed === 0) return 1;
  let atLeastObserved = 0;
  for (let iteration = 0; iteration < options.bootstrapIterations; iteration += 1) {
    const permutedMean =
      deltas.reduce((total, delta) => total + (options.rng() < 0.5 ? delta : -delta), 0) /
      deltas.length;
    if (Math.abs(permutedMean) >= observed) atLeastObserved += 1;
  }
  return (atLeastObserved + 1) / (options.bootstrapIterations + 1);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mean(values) {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  const left = sorted[middle - 1];
  const right = sorted[middle];
  return left === undefined || right === undefined ? undefined : (left + right) / 2;
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

function formatNumber(value) {
  return value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(4);
}

function formatPValue(value) {
  return value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(6);
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
