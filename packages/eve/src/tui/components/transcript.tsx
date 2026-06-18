/**
 * The transcript, ported to components. eve renders every block as a gutter
 * glyph plus a hanging-indented body; that maps to a Yoga row of a fixed-width
 * `<Gutter>` column and a flexing content column, so wrapped body lines align
 * under the gutter automatically. `<Transcript>` dispatches eve's `Block` model
 * to `<Message>` / `<ToolCall>` / `<ErrorBlock>` / `<Notice>` and the
 * setup/IO kinds below.
 *
 * Ported kinds: user, assistant, reasoning, tool, error, notice, warning,
 * flow, command, question, connection-auth, sandbox, log, subagent header
 * (+ subagent step/tool reuse message/tool). A `depth > 0` block is wrapped in
 * the orange nesting rule that contains a subagent's output. Not yet ported:
 * agent-header — a follow-up.
 */
import type { ReactNode } from "react";

import type { Block, BlockKind, ToolStatus } from "../../cli/dev/tui/blocks.js";
import type { StyledSegment } from "../cells/style.js";
import { Box, glyph, Text, type Tone, toneStyle } from "./primitives.js";
import { Markdown } from "./markdown.js";

/** A left gutter glyph + a flexing content column (the hanging-indent layout). */
function Gutter({ mark, tone, children }: { mark: string; tone?: Tone; children: ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box width={2}>
        <Text tone={tone}>{mark}</Text>
      </Box>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

function combined(...tones: Tone[]): StyledSegment["style"] {
  return tones.map(toneStyle).join("");
}

export function Message({ block }: { block: Block }) {
  if (block.kind === "user") {
    return (
      <Gutter mark={glyph.user} tone="cyan">
        <Text>{block.body ?? ""}</Text>
      </Gutter>
    );
  }

  if (block.kind === "reasoning") {
    if (block.collapsed) {
      return (
        <Gutter mark={glyph.reasoning} tone="gray">
          <Text tone="dim">thinking</Text>
        </Gutter>
      );
    }
    return (
      <Gutter mark={glyph.reasoning} tone="gray">
        <Text segments={[{ text: (block.body ?? "").trim(), style: combined("dim", "italic") }]} />
      </Gutter>
    );
  }

  // assistant / subagent-step
  const body = (block.body ?? "").trim();
  return (
    <Gutter mark={glyph.brand} tone="white">
      {body.length > 0 ? (
        <Markdown source={body} />
      ) : (
        <Text tone="dim">{`thinking${glyph.ellipsis}`}</Text>
      )}
    </Gutter>
  );
}

const TOOL: Record<ToolStatus, { mark: string; tone: Tone; accent: Tone }> = {
  done: { mark: glyph.success, tone: "green", accent: "gray" },
  error: { mark: glyph.error, tone: "red", accent: "red" },
  denied: { mark: glyph.warning, tone: "yellow", accent: "yellow" },
  approval: { mark: glyph.question, tone: "yellow", accent: "yellow" },
  running: { mark: glyph.pointer, tone: "yellow", accent: "gray" },
};

export function ToolCall({ block }: { block: Block }) {
  const status = block.status ?? "running";
  const { mark, tone, accent } = TOOL[status];
  const name = block.title ?? "tool";
  const args = block.subtitle ?? "";
  const result = block.result ?? "";

  return (
    <Gutter mark={mark} tone={tone}>
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text segments={[{ text: name, style: toneStyle("bold") }]} />
          {args.length > 0 ? <Text tone="gray">{`  ${args}`}</Text> : null}
        </Box>
        {result.length > 0 && (status === "done" || status === "error") ? (
          <Box flexDirection="row">
            <Text tone="dim">{`${glyph.arrow} `}</Text>
            <Text tone={status === "error" ? "red" : accent}>{result}</Text>
          </Box>
        ) : null}
        {status === "denied" ? (
          <Box flexDirection="row">
            <Text tone="dim">{`${glyph.arrow} `}</Text>
            <Text tone="yellow">denied</Text>
          </Box>
        ) : null}
      </Box>
    </Gutter>
  );
}

function ErrorBlock({ block }: { block: Block }) {
  return (
    <Gutter mark={glyph.error} tone="red">
      <Box flexDirection="column">
        <Text segments={[{ text: block.title ?? "Error", style: combined("red", "bold") }]} />
        {block.body ? <Text tone="red">{block.body}</Text> : null}
      </Box>
    </Gutter>
  );
}

function Notice({ block }: { block: Block }) {
  return (
    <Gutter mark={glyph.dot} tone="dim">
      <Text tone="dim">{block.body ?? ""}</Text>
    </Gutter>
  );
}

/**
 * The setup attention line (`⚠ <body>`): a yellow warning glyph in the gutter,
 * the body kept at full intensity. Mirrors `renderWarning`/`renderAttentionRows`
 * in blocks.ts; slash-command painting is left to the markdown projection.
 */
export function Warning({ block }: { block: Block }) {
  return (
    <Gutter mark={glyph.warning} tone="yellow">
      <Text>{block.body ?? ""}</Text>
    </Gutter>
  );
}

/**
 * One slash-command outcome, hung under its invocation by the dim `⎿` elbow
 * connector (`renderResult` in blocks.ts). Used by `renderCommandResult`.
 */
function Result({ block }: { block: Block }) {
  return (
    <Box flexDirection="row">
      <Text tone="dim">{`${glyph.elbow} `}</Text>
      <Box flexGrow={1}>
        <Text tone="dim">{block.body ?? ""}</Text>
      </Box>
    </Box>
  );
}

/**
 * One persistent setup-flow line. The tone travels in `title` ("info" | "success"
 * | "warning" | "error"); the gutter glyph follows the tone and an `info` body
 * dims while the louder tones keep the body at full intensity. Mirrors
 * `renderFlow` in blocks.ts.
 */
const FLOW: Record<string, { mark: string; tone: Tone }> = {
  success: { mark: glyph.success, tone: "green" },
  warning: { mark: glyph.warning, tone: "yellow" },
  error: { mark: glyph.error, tone: "red" },
  info: { mark: glyph.dot, tone: "dim" },
};

function Flow({ block }: { block: Block }) {
  const tone = block.title ?? "info";
  const spec = FLOW[tone] ?? { mark: glyph.dot, tone: "dim" as Tone };
  return (
    <Gutter mark={spec.mark} tone={spec.tone}>
      <Text tone={tone === "info" ? "dim" : undefined}>{block.body ?? ""}</Text>
    </Gutter>
  );
}

/**
 * A typed slash command echoed in the user-message grammar — the cyan gutter
 * bar (the user typed it) with the command itself blue to mark the dispatch.
 * Mirrors `renderCommand` in blocks.ts; deliberately NOT the prompt glyph.
 */
function Command({ block }: { block: Block }) {
  return (
    <Gutter mark={glyph.user} tone="cyan">
      <Text tone="blue">{block.body ?? ""}</Text>
    </Gutter>
  );
}

/**
 * A question / connection-auth prompt. The title is agent-authored prose shown
 * bold after a yellow glyph; the body arrives pre-styled, so each logical line
 * is rendered as its own plain wrapped `<Text>` (no markdown re-parsing).
 * Mirrors `renderPreformatted` in blocks.ts.
 */
function Preformatted({ block }: { block: Block }) {
  const mark = block.kind === "connection-auth" ? glyph.connection : glyph.question;
  const titleStyle =
    block.kind === "connection-auth" ? combined("yellow") : combined("yellow", "bold");
  const bodyLines = (block.body ?? "").split("\n");
  return (
    <Gutter mark={mark} tone="yellow">
      <Box flexDirection="column">
        {block.title ? <Text segments={[{ text: block.title, style: titleStyle }]} /> : null}
        {bodyLines.map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
      </Box>
    </Gutter>
  );
}

/**
 * A `│`-ruled IO run: a captured server write (`log`) or sandbox output. The
 * source label (`stdout ·` / `stderr ·` / `sandbox ·`) sits on the first row;
 * continuation lines hang indented beneath it. When the block directly
 * continues a same-source run, the label is suppressed so consecutive writes
 * read as one block. Mirrors `renderLog` / `renderSandbox` in blocks.ts.
 */
function IoRun({ block, previous }: { block: Block; previous?: PrevContext }) {
  const isSandbox = block.kind === "sandbox";
  const isErr = !isSandbox && block.title === "stderr";
  const source = isSandbox ? "sandbox" : isErr ? "stderr" : "stdout";
  const ruleTone: Tone = isSandbox ? "cyan" : "dim";
  const bodyTone: Tone = isSandbox ? "gray" : isErr ? "red" : "gray";
  const continuesRun = isSandbox
    ? previous?.kind === "sandbox"
    : previous?.kind === "log" && previous.title === block.title;

  // The dim source label uses a literal, dim-prefixed segment so the gray/red
  // body that follows keeps its own intensity. log bodies are additionally dim.
  const label = `${source} ${glyph.dot} `;
  const labelSegment: StyledSegment = { text: label, style: toneStyle("dim") };
  const bodyStyle = isSandbox ? combined(bodyTone) : combined("dim", bodyTone);
  const lines = (block.body ?? "").split("\n");

  return (
    <Gutter mark={glyph.rule} tone={ruleTone}>
      <Box flexDirection="column">
        {lines.map((line, index) => {
          const showLabel = index === 0 && !continuesRun;
          const segments: StyledSegment[] = showLabel
            ? [labelSegment, { text: line, style: bodyStyle }]
            : [{ text: `${" ".repeat(label.length)}${line}`, style: bodyStyle }];
          return <Text key={index} segments={segments} />;
        })}
      </Box>
    </Gutter>
  );
}

/** A subagent region header: `◆ <name> subagent`. Mirrors `renderSubagentHeader`. */
function SubagentHeader({ block }: { block: Block }) {
  return (
    <Gutter mark={glyph.subagent} tone="orange">
      <Box flexDirection="row">
        <Text segments={[{ text: block.title ?? "subagent", style: toneStyle("bold") }]} />
        <Text tone="dim">{" subagent"}</Text>
      </Box>
    </Gutter>
  );
}

/**
 * Wraps a block in the Vercel-orange nesting rule (`│ ` per level) that visually
 * contains a subagent's output beneath its header. Mirrors `nestingPrefix`.
 */
function Nested({ depth, children }: { depth: number; children: ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box flexDirection="row" width={depth * 2}>
        <Text tone="orange">{`${glyph.rule} `.repeat(depth)}</Text>
      </Box>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

interface PrevContext {
  kind: BlockKind;
  title?: string;
}

function BlockBody({ block, previous }: { block: Block; previous?: PrevContext }) {
  switch (block.kind) {
    case "user":
    case "assistant":
    case "reasoning":
    case "subagent-step":
      return <Message block={block} />;
    case "tool":
    case "subagent-tool":
      return <ToolCall block={block} />;
    case "error":
      return <ErrorBlock block={block} />;
    case "notice":
      return <Notice block={block} />;
    case "result":
      return <Result block={block} />;
    case "warning":
      return <Warning block={block} />;
    case "flow":
      return <Flow block={block} />;
    case "command":
      return <Command block={block} />;
    case "question":
    case "connection-auth":
      return <Preformatted block={block} />;
    case "sandbox":
    case "log":
      return <IoRun block={block} previous={previous} />;
    case "subagent":
      return <SubagentHeader block={block} />;
    default:
      return block.body ? <Text>{block.body}</Text> : null;
  }
}

function BlockView({ block, previous }: { block: Block; previous?: PrevContext }) {
  const body = <BlockBody block={block} previous={previous} />;
  const depth = block.depth ?? 0;
  return depth > 0 ? <Nested depth={depth}>{body}</Nested> : body;
}

export function Transcript({ blocks }: { blocks: readonly Block[] }) {
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        const prev = index > 0 ? blocks[index - 1] : undefined;
        const previous = prev ? { kind: prev.kind, title: prev.title } : undefined;
        return <BlockView key={block.id ?? index} block={block} previous={previous} />;
      })}
    </Box>
  );
}
