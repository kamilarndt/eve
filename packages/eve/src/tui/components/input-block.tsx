/**
 * The live prompt input line, authored as a component tree (the port of the
 * imperative `promptInputRows` + `visibleLine` path). It reads the input slice
 * from `shared` and renders `<glyph.prompt> <before><caret><after>`, where the
 * caret is a cyan caret glyph sitting between the text on either side of the
 * cursor. Long lines are windowed around the caret via `visibleLine` so the
 * caret stays on screen. Composition is the JSX tree; styled runs are segments.
 */
import type { StyledSegment } from "../cells/style.js";
import { useShared } from "../store.js";
import { visibleLine } from "../../cli/dev/tui/line-editor.js";
import { glyph, Text, toneStyle } from "./primitives.js";

const cyan = toneStyle("cyan");

/** The interactive prompt row: prompt glyph, the draft text, and the caret. */
export function InputBlock({ width }: { readonly width: number }) {
  const input = useShared((state) => state.input);
  const text = input?.text ?? "";
  const cursor = input?.cursor ?? 0;

  // Reserve three columns (prompt glyph, its trailing space, the caret) so the
  // windowed text matches the imperative renderer's budget exactly.
  const budget = Math.max(4, width - 3);
  const { before, after } = visibleLine({ text, cursor }, budget, glyph.ellipsis);

  // One Text leaf — `<glyph.prompt> <before><caret><after>` — so the whole line
  // wraps in a single context at the full width and the styled runs stay
  // adjacent; the prompt and caret are the cyan prompt/caret glyphs.
  const segments: StyledSegment[] = [
    { text: `${glyph.prompt} `, style: cyan },
    { text: before, style: "" },
    { text: glyph.caret, style: cyan },
    { text: after, style: "" },
  ];

  return <Text segments={segments} />;
}
