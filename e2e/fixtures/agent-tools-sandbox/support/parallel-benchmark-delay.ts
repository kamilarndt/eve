const DEFAULT_LOOKUP_DELAY_MS = 3_000;
const LOOKUP_DELAY_ENV = "EVE_PARALLEL_BENCHMARK_LOOKUP_DELAY_MS";

export function parallelBenchmarkLookupDelayMs(): number {
  const raw = process.env[LOOKUP_DELAY_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_LOOKUP_DELAY_MS;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LOOKUP_DELAY_MS;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
