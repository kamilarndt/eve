/**
 * The status bar, authored as a component tree (the port of the imperative
 * `buildStatusLine`). Each segment is a styled `<Text>`; the row layout and the
 * dot separators are the JSX tree, not a concatenated string. Segments are
 * conditional on what the store holds — a writer updating `shared` re-renders
 * only this component.
 *
 * Width degradation (the port of `buildStatusLine`'s variant cascade): when the
 * assembled row exceeds the terminal width, segments are dropped in a fixed
 * priority — project first, then model — keeping the token flow and the louder
 * yellow hints (deploy pending, connection-auth wait) longest. This is the
 * measure-and-pick form of the terminal's descending-fidelity variants.
 */
import type { ReactNode } from "react";

import { visibleLength } from "../../cli/dev/tui/terminal-text.js";
import { useShared } from "../store.js";
import { Box, glyph, Text, type Tone } from "./primitives.js";

/** Visible width of the dot separator (`  ·  `) between two segments. */
const SEPARATOR_WIDTH = 5;

interface Segment {
  key: string;
  text: string;
  tone: Tone;
}

/** Segment keys eligible for dropping, in drop order (first dropped first). The
 * token flow and the yellow hints are never dropped. */
const DROP_ORDER = ["project", "model"];

function Separator() {
  return <Text tone="dim">{`  ${glyph.dot}  `}</Text>;
}

function rowWidth(segments: Segment[]): number {
  return segments.reduce(
    (total, segment, index) =>
      total + visibleLength(segment.text) + (index > 0 ? SEPARATOR_WIDTH : 0),
    0,
  );
}

export function StatusBar({ width }: { readonly width: number }) {
  const model = useShared((state) => state.model);
  const tokens = useShared((state) => state.tokens);
  const vercel = useShared((state) => state.vercel);
  const connectionAuthPending = useShared((state) => state.connectionAuthPending);
  const identity = vercel?.identity;

  const segments: Segment[] = [];
  // A parked connection-auth wait overrides the line so the agent reads as
  // waiting, not hung (mirrors the terminal renderer's status override).
  if (connectionAuthPending && connectionAuthPending > 0)
    segments.push({
      key: "conn-auth",
      text: "Waiting for connection authorization…",
      tone: "yellow",
    });
  if (model) segments.push({ key: "model", text: model, tone: "dim" });
  if (tokens) segments.push({ key: "tokens", text: tokens, tone: "dim" });
  if (identity)
    segments.push({
      key: "project",
      text: identity.teamName
        ? `${glyph.brand} ${identity.projectName} (${identity.teamName})`
        : `${glyph.brand} ${identity.projectName}`,
      tone: "dim",
    });
  if (vercel?.pendingDeploy)
    segments.push({ key: "deploy", text: "deploy pending", tone: "yellow" });

  // Drop low-priority segments until the row fits the available width.
  let kept = segments;
  for (const dropKey of DROP_ORDER) {
    if (rowWidth(kept) <= width) break;
    kept = kept.filter((segment) => segment.key !== dropKey);
  }

  const children: ReactNode[] = [];
  kept.forEach((segment, index) => {
    if (index > 0) children.push(<Separator key={`sep-${index}`} />);
    children.push(
      <Text key={segment.key} tone={segment.tone}>
        {segment.text}
      </Text>,
    );
  });

  return <Box flexDirection="row">{children}</Box>;
}
