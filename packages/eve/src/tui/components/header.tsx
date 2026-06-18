/**
 * The startup header, ported to components. Mirrors `buildAgentHeader`: a brand
 * line (`▲`-less here — eve uses a bold `eve` word mark, not the brand glyph),
 * a public-preview line, an optional discovery-diagnostics line, and an optional
 * rotating tip. The resolved model is intentionally absent — it lives on the
 * persistent status line, not the committed header.
 *
 * Each row carries a one-space left margin to match the imperative builder's
 * leading-space prefix; styling is expressed via `Text` tones/segments rather
 * than ANSI strings.
 */
import type { ReactNode } from "react";

import type { AgentInfoResult } from "#client/index.js";
import { EVE_BETA_TERMS_URL } from "#cli/banner.js";

import { truncate } from "../../cli/dev/tui/tool-format.js";
import { Box, glyph, Text, type Tone, toneStyle } from "./primitives.js";

export interface HeaderProps {
  /** Resolved display name (e.g. "weather-agent"). */
  name: string;
  /** Agent inspection payload, or `undefined` when it could not be fetched. */
  info?: AgentInfoResult;
  /** Available terminal width. */
  width: number;
  /** Message-of-the-day line rendered under the brand line, when present. */
  tip?: string;
}

function combined(...tones: Tone[]): string {
  return tones.map(toneStyle).join("");
}

/** A header row with the one-space left margin the imperative builder prepends. */
function Row({ children }: { children: ReactNode }) {
  return (
    <Box flexDirection="row">
      <Box width={1} />
      {children}
    </Box>
  );
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

/** Startup header committed to scrollback before the first prompt. */
export function Header({ name, info, width, tip }: HeaderProps) {
  const diagnostics = info?.diagnostics;
  const showDiagnostics =
    diagnostics !== undefined &&
    (diagnostics.discoveryErrors > 0 || diagnostics.discoveryWarnings > 0);

  return (
    <Box flexDirection="column">
      <Row>
        <Text segments={[{ text: "eve", style: toneStyle("bold") }]} />
        <Text> </Text>
        <Text tone="dim">{truncate(name, Math.max(8, width - 8))}</Text>
      </Row>
      <Row>
        <Text tone="dim">
          {truncate(`Public preview: ${EVE_BETA_TERMS_URL}`, Math.max(8, width - 2))}
        </Text>
      </Row>
      {showDiagnostics ? (
        <Row>
          <Text tone="dim">{`${glyph.warning} `}</Text>
          <Text segments={diagnosticSegments(diagnostics)} />
        </Row>
      ) : null}
      {tip !== undefined ? (
        <Row>
          <Text tone="dim">{truncate(tip, Math.max(8, width - 2))}</Text>
        </Row>
      ) : null}
    </Box>
  );

  function diagnosticSegments(d: NonNullable<typeof diagnostics>) {
    const segments: { text: string; style: string }[] = [];
    if (d.discoveryErrors > 0) {
      segments.push({
        text: `${d.discoveryErrors} error${plural(d.discoveryErrors)}`,
        style: toneStyle("red"),
      });
    }
    if (d.discoveryWarnings > 0) {
      if (segments.length > 0) {
        segments.push({ text: " · ", style: combined("dim") });
      }
      segments.push({
        text: `${d.discoveryWarnings} warning${plural(d.discoveryWarnings)}`,
        style: toneStyle("yellow"),
      });
    }
    return segments;
  }
}
