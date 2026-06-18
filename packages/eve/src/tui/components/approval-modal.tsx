/**
 * The tool-approval prompt, driven by `shared.approval`. Shown while
 * `mode === "approval"`; the renderer's `readToolApproval` promise is awaiting
 * the choice. Presentation owns the raw request (the renderer stores it
 * verbatim), replacing the imperative `formatToolApprovalTitle`. Keyboard
 * routing (←/→ + enter, or y/n) lives in the P3 input router; this component is
 * a pure store reader.
 */
import { useShared } from "../store.js";
import { Box, glyph, Text, toneStyle } from "./primitives.js";

export function ApprovalModal() {
  const approval = useShared((s) => s.approval);
  if (!approval) return null;
  const { request, cursor } = approval;
  const title = (request.title ?? request.toolName).trim() || request.toolName;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2}>
          <Text tone="yellow">{glyph.question}</Text>
        </Box>
        <Text segments={[{ text: `Approve ${title}?`, style: toneStyle("bold") }]} />
      </Box>
      <Box flexDirection="row">
        <Box width={2} />
        <Text tone={cursor === 0 ? "green" : "dim"}>
          {`${cursor === 0 ? glyph.pointer : " "} approve`}
        </Text>
        <Text tone={cursor === 1 ? "red" : "dim"}>
          {`   ${cursor === 1 ? glyph.pointer : " "} deny`}
        </Text>
      </Box>
    </Box>
  );
}
