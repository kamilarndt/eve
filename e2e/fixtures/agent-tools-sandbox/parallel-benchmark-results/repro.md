# Parallel action prompt benchmark

While building a coding agent with eve, I noticed that tool-call execution
appeared more serial than in other agent harnesses. Several explanations could
fit that behavior, so I wanted to isolate a low-cost hypothesis first: does
eve's framework-owned prompt make the parallelism affordance clear enough to the
model?

In branch `rui/exp-parallel-tool-advs`, I started measuring that prompt change.
The branch adds a control/treatment prompt variant, natural eval tasks with many
independent lookups, a benchmark runner, and persisted paired results. The
current sample is still small, but `ticket-triage-80` shows the clearest
wall-time signal so far: treatment averaged 53,285 ms versus 71,278 ms for
control over 7 paired runs.

## Branch details

- Repo: `vercel/eve`
- Current local branch: `rui/exp-parallel-tool-advs`
- Upstream: `origin/main`
- Pushed branch: `origin/rui/exp-parallel-tool-advs`

## What is in the repro

- Natural fixture evals under `e2e/fixtures/agent-tools-sandbox/evals/sandbox/`.
- Synthetic lookup tools with a default 3 second delay, so serialized calls show up in wall time.
- A benchmark runner that compares `EVE_PARALLEL_ACTION_PROMPT_VARIANT=control` and `treatment`.
- A stats script that writes paired wall-time results to TSV.

## Run it

Run the full paired benchmark suite from the repository root:

```sh
pnpm --filter agent-tools-sandbox benchmark:parallel -- \
  --runs 10 \
  --timeout 300000 \
  --seed 20260629 \
  --jsonl parallel-benchmark-results/2026-06-29-all-aligned-runs-10.jsonl
```

Then compute paired statistics:

```sh
pnpm --filter agent-tools-sandbox stats:parallel -- \
  --input parallel-benchmark-results/2026-06-29-all-aligned-runs-10.jsonl \
  --output parallel-benchmark-results/2026-06-29-all-aligned-runs-7.stats.tsv \
  --bootstrap 10000 \
  --seed 20260629
```

The benchmark runner creates a temporary `MSB_HOME` by default. This avoids
stale local microsandbox databases affecting the run.

## Current result

I stopped the latest run after 7 complete paired runs. That produced 70 raw
measurement rows. Every row passed and every row had a measurement log.

| Scenario            | Control Mean | Treatment Mean |      Delta | Relative Delta |  p-value |
| ------------------- | -----------: | -------------: | ---------: | -------------: | -------: |
| revenue-screen      |    25,619 ms |      19,577 ms |  -6,042 ms |         -23.6% | 0.295470 |
| ticket-triage       |    22,356 ms |      13,668 ms |  -8,688 ms |         -38.9% | 0.061594 |
| ticket-triage-80    |    71,278 ms |      53,285 ms | -17,993 ms |         -25.2% | 0.031097 |
| vendor-risk         |    14,082 ms |      15,835 ms |  +1,753 ms |         +12.4% | 0.357564 |
| workspace-health-80 |    50,198 ms |      41,150 ms |  -9,047 ms |         -18.0% | 0.129887 |

## Interpretation

Wall time is the metric that matters here. The treatment prompt does not change
whether the evals pass. It changes how quickly the agent gets through work that
can be fanned out.

`ticket-triage-80` is the strongest signal: treatment is about 25% faster, with
paired permutation `p = 0.031097`.

The smaller scenarios have less room to show a wall-time difference.
`vendor-risk` regressed in mean wall time, but the result is noisy. I would
treat this as evidence to keep testing the prompt boundary, not as proof that
this is the exact wording we should ship.
