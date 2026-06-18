/**
 * The live setup-flow panel — the React analogue of `renderFlowPanel`. Shown
 * while a `/setup`-family command runs (`setupFlow.begin`→`end`), it renders the
 * command title, recent progress lines (toned), a transient subprocess preview,
 * a status spinner line, and — when a read is open — the interactive question
 * (select / text / acknowledge / action choice). A pure store reader; the
 * renderer's `setupFlow` methods own the keyboard rendezvous that drives it.
 */
import type { SetupFlowQuestion, SetupFlowState } from "../store.js";
import { useShared } from "../store.js";
import { Box, glyph, Text, type Tone } from "./primitives.js";

const LINE_TONE: Record<SetupFlowState["lines"][number]["tone"], Tone> = {
  info: "dim",
  success: "green",
  warning: "yellow",
  error: "red",
};

function Question({ question }: { question: SetupFlowQuestion }) {
  if (question.kind === "acknowledge") {
    return (
      <Box flexDirection="column">
        <Text>{question.message}</Text>
        {question.lines.map((line, index) => (
          <Text key={index} tone="dim">
            {line}
          </Text>
        ))}
        <Text tone="dim">{`${glyph.dot} press enter to continue`}</Text>
      </Box>
    );
  }

  if (question.kind === "text") {
    return (
      <Box flexDirection="column">
        <Text>{question.message}</Text>
        <Box flexDirection="row">
          <Text tone="cyan">{`${glyph.prompt} `}</Text>
          <Text>{question.mask ? "•".repeat(question.text.length) : question.text}</Text>
          <Text tone="cyan">{glyph.caret}</Text>
        </Box>
        {question.error ? <Text tone="red">{question.error}</Text> : null}
      </Box>
    );
  }

  if (question.kind === "choice") {
    return (
      <Box flexDirection="column">
        <Text tone="dim">{question.status}</Text>
        <Text>{question.context}</Text>
        {question.actions.map((action, index) => (
          <Box key={action.value} flexDirection="row">
            <Text tone={index === question.cursor ? "cyan" : "dim"}>
              {`${index === question.cursor ? glyph.pointer : " "} ${action.label}`}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  // select / multi-select
  return (
    <Box flexDirection="column">
      <Text>{question.message}</Text>
      {question.options.map((option, index) => {
        const focused = index === question.cursor;
        const checked = question.selected.includes(option.value);
        const box = question.multi ? (checked ? "[x] " : "[ ] ") : "";
        const tone: Tone = option.disabled ? "dim" : focused ? "cyan" : "dim";
        return (
          <Box key={option.value} flexDirection="row">
            <Text tone={tone}>{`${focused ? glyph.pointer : " "} ${box}${option.label}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function FlowPanel() {
  const flow = useShared((s) => s.setupFlow);
  if (!flow) return null;
  return (
    <Box flexDirection="column">
      {flow.title ? <Text tone="dim">{flow.title}</Text> : null}
      {flow.lines.map((line, index) => (
        <Text key={index} tone={LINE_TONE[line.tone]}>
          {line.text}
        </Text>
      ))}
      {flow.preview ? <Text tone="dim">{flow.preview}</Text> : null}
      {flow.status && !flow.question ? (
        <Text tone="dim">{`${glyph.pointer} ${flow.status}`}</Text>
      ) : null}
      {flow.question ? <Question question={flow.question} /> : null}
    </Box>
  );
}
