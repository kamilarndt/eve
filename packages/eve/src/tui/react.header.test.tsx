import { describe, expect, it } from "vitest";

import type { AgentInfoResult } from "#client/index.js";

import { Header } from "./components/header.js";
import { mountForTest } from "./testing.js";

/**
 * <Header> reproduces buildAgentHeader's committed rows: a bold `eve` word mark
 * with the dim agent name, the public-preview line, an optional diagnostics
 * line, and an optional tip — as a component tree, not an ANSI string.
 */
describe("<Header>", () => {
  it("renders the brand word mark and the agent name", () => {
    const handle = mountForTest(<Header name="weather-agent" width={80} />, {
      width: 80,
      height: 6,
    });
    const frame = handle.captureCharFrame();
    expect(frame).toContain("eve weather-agent");
    expect(frame).toContain("Public preview:");
    handle.unmount();
  });

  it("renders the tip line when provided", () => {
    const handle = mountForTest(
      <Header name="agent" width={80} tip="Type /help to see every command." />,
      { width: 80, height: 6 },
    );
    expect(handle.captureCharFrame()).toContain("Type /help to see every command.");
    handle.unmount();
  });

  it("renders the discovery diagnostics line when the compiler reported problems", () => {
    const info = {
      diagnostics: { discoveryErrors: 2, discoveryWarnings: 1 },
    } as AgentInfoResult;
    const handle = mountForTest(<Header name="agent" width={80} info={info} />, {
      width: 80,
      height: 6,
    });
    const frame = handle.captureCharFrame();
    expect(frame).toContain("2 errors");
    expect(frame).toContain("1 warning");
    handle.unmount();
  });

  it("omits the diagnostics line when there are no discovery problems", () => {
    const info = {
      diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
    } as AgentInfoResult;
    const handle = mountForTest(<Header name="agent" width={80} info={info} />, {
      width: 80,
      height: 6,
    });
    expect(handle.captureCharFrame()).not.toContain("error");
    handle.unmount();
  });
});
