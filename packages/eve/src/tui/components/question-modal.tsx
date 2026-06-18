/**
 * An input question (`readInputQuestion`), driven by `shared.question`. Shown
 * while `mode === "question"`. Branches on `request.display`: a "select" renders
 * the option list with the cursor marker; a "text" renders a freeform editor row
 * with the synthetic caret. A pure store reader — key routing lives in the P3
 * input router.
 */
import { useShared } from "../store.js";
import { Box, glyph, Text, toneStyle } from "./primitives.js";

export function QuestionModal() {
  const question = useShared((s) => s.question);
  if (!question) return null;
  const { request, text, optionCursor } = question;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2}>
          <Text tone="yellow">{glyph.question}</Text>
        </Box>
        <Text segments={[{ text: request.prompt, style: toneStyle("bold") }]} />
      </Box>
      {request.display === "select" ? (
        (request.options ?? []).map((option, index) => (
          <Box key={option.id} flexDirection="row">
            <Box width={2} />
            <Text tone={index === optionCursor ? "cyan" : "dim"}>
              {`${index === optionCursor ? glyph.pointer : " "} ${option.label}`}
            </Text>
          </Box>
        ))
      ) : (
        <Box flexDirection="row">
          <Box width={2} />
          <Text tone="cyan">{`${glyph.prompt} `}</Text>
          <Text>{text}</Text>
          <Text tone="cyan">{glyph.caret}</Text>
        </Box>
      )}
    </Box>
  );
}
