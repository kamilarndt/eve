import { defineTool } from "eve/tools";
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
