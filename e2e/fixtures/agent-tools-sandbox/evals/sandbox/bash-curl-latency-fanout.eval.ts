import { defineEval } from "eve/evals";

import { bashCurlLatencyCallsMatch, formatBashCurlLatencyTrace } from "./bash-latency.js";
import { FANOUT_DELAY_SERVER_URL } from "./shared.js";

const REQUESTS = [
  { label: "latency-01", query: "Vercel AI Gateway documentation" },
  { label: "latency-02", query: "Anthropic Claude API documentation" },
  { label: "latency-03", query: "OpenAI API documentation" },
  { label: "latency-04", query: "Node.js fetch documentation" },
  { label: "latency-05", query: "React useEffect documentation" },
  { label: "latency-06", query: "TypeScript handbook generics" },
  { label: "latency-07", query: "MDN Fetch API documentation" },
  { label: "latency-08", query: "GitHub Actions documentation" },
  { label: "latency-09", query: "AWS Lambda documentation" },
  { label: "latency-10", query: "Google Search Central documentation" },
] as const;

export default defineEval({
  description:
    "Sandbox Bash latency: ten independent fixed-latency curl requests expose local tool scheduling delay.",
  async test(t) {
    const turn = await t.send(
      [
        `Call the \`bash\` tool exactly ${REQUESTS.length} separate times in one tool-use step.`,
        "Run each command below exactly once. Do not combine commands, use a loop, background a process, or call another tool.",
        ...REQUESTS.map((request) => `${request.label}: \`${commandForRequest(request)}\``),
        "After all commands return, reply with exactly: bash curl latency fanout complete",
      ].join("\n"),
    );
    turn.expectOk();
    t.log(formatBashCurlLatencyTrace(turn.events));

    t.didNotFail();
    t.completed();
    t.calledTool("bash", { isError: false, times: REQUESTS.length });
    t.noFailedActions();
    t.event(
      (events) => bashCurlLatencyCallsMatch({ events, expectedRequests: REQUESTS }),
      "all ten Bash curl requests completed against the fixed-latency endpoint",
    );
  },
});

function commandForRequest(request: (typeof REQUESTS)[number]): string {
  const url = new URL(FANOUT_DELAY_SERVER_URL);
  url.searchParams.set("label", request.label);
  url.searchParams.set("q", request.query);

  return [
    "started=$(date +%s%3N)",
    `response=$(curl -fsS --max-time 20 '${url.href}')`,
    "completed=$(date +%s%3N)",
    'printf \'{"clientStartedAtMs":%s,"clientCompletedAtMs":%s,"server":%s}\\n\' "$started" "$completed" "$response"',
  ].join("; ");
}
