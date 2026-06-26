import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

const IDLE_STREAM_REPRO_TSCONFIG_SOURCE = `${JSON.stringify(
  {
    $schema: "https://json.schemastore.org/tsconfig",
    compilerOptions: {
      allowJs: true,
      erasableSyntaxOnly: true,
      forceConsistentCasingInFileNames: true,
      isolatedModules: true,
      lib: ["ES2024"],
      module: "NodeNext",
      moduleDetection: "force",
      moduleResolution: "NodeNext",
      noEmit: true,
      noFallthroughCasesInSwitch: true,
      noImplicitOverride: true,
      noUncheckedIndexedAccess: true,
      resolveJsonModule: true,
      rootDir: ".",
      skipLibCheck: true,
      strict: true,
      target: "ES2024",
      types: ["node"],
      useUnknownInCatchVariables: true,
      verbatimModuleSyntax: true,
    },
    exclude: ["node_modules", "dist", "build", ".turbo", ".vercel"],
    include: ["agent/**/*"],
  },
  null,
  2,
)}\n`;

/**
 * Scenario-tier eve app for reproducing a stale client stream after an inline
 * tool starts. The tool waits before returning, which gives a proxy enough
 * time to stop forwarding the live response while durable tail events remain
 * replayable from the session stream route.
 */
export const IDLE_STREAM_REPRO_DESCRIPTOR: ScenarioAppDescriptor = {
  dependencies: {
    zod: "^4.3.6",
  },
  files: {
    "agent/agent.ts": `import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.4-mini",
});
`,
    "agent/instructions.md": `You are an idle stream repro assistant. Call the \`idle_stream_repro\` tool when the user asks for it. After the tool returns, reply with the returned label and status.
`,
    "agent/tools/idle_stream_repro.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Repro fixture: waits before returning a deterministic image marker. Only call when the user explicitly asks for idle_stream_repro.",
  inputSchema: z.object({
    delayMs: z.coerce.number().int().min(0).max(30_000).default(8_000),
    label: z.string(),
  }),
  async execute(input) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));

    return {
      image: "repro-image.png",
      label: input.label,
      status: "completed",
    };
  },
});
`,
    "tsconfig.json": IDLE_STREAM_REPRO_TSCONFIG_SOURCE,
  },
  installDependencies: true,
  name: "agent-idle-stream-repro",
};
