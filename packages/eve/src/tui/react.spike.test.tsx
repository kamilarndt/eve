import { describe, expect, it } from "vitest";

import { mountForTest } from "./testing.js";

/**
 * P0/P1 pipeline, authored as JSX (proves the JSX transform flows through
 * vitest -> reconciler -> nodes -> Yoga -> cells).
 */
describe("react tui spike (JSX)", () => {
  const App = ({ label }: { label: string }) => (
    <eve-box>
      <eve-text>{label}</eve-text>
    </eve-box>
  );

  it("renders a JSX tree to cells on Node", () => {
    const handle = mountForTest(<App label="hi" />, { width: 20, height: 3 });
    expect(handle.captureCharFrame()).toBe("hi");
    handle.unmount();
  });

  it("re-renders cells when props change", () => {
    const handle = mountForTest(<App label="first" />, { width: 20, height: 3 });
    expect(handle.captureCharFrame()).toContain("first");
    handle.update(<App label="second" />);
    expect(handle.captureCharFrame()).toContain("second");
    expect(handle.captureCharFrame()).not.toContain("first");
    handle.unmount();
  });

  it("lays out a column top-to-bottom (Yoga)", () => {
    const handle = mountForTest(
      <eve-box flexDirection="column">
        <eve-text>top</eve-text>
        <eve-text>bottom</eve-text>
      </eve-box>,
      { width: 20, height: 4 },
    );
    expect(handle.captureCharFrame()).toBe("top\nbottom");
    handle.unmount();
  });

  it("lays out a row left-to-right (Yoga)", () => {
    const handle = mountForTest(
      <eve-box flexDirection="row">
        <eve-text>AA</eve-text>
        <eve-text>BB</eve-text>
      </eve-box>,
      { width: 20, height: 2 },
    );
    expect(handle.captureCharFrame()).toBe("AABB");
    handle.unmount();
  });

  it("positions a row inside a column at the right offset", () => {
    const handle = mountForTest(
      <eve-box flexDirection="column">
        <eve-text>header</eve-text>
        <eve-box flexDirection="row">
          <eve-text>{"L "}</eve-text>
          <eve-text>R</eve-text>
        </eve-box>
      </eve-box>,
      { width: 20, height: 4 },
    );
    expect(handle.captureCharFrame()).toBe("header\nL R");
    handle.unmount();
  });
});
