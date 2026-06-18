import { createElement as h } from "react";
import { describe, expect, it } from "vitest";

import { mountForTest } from "./testing.js";

/**
 * Keyed-reorder + deletion reconciler semantics (review finding #2).
 *
 * A keyed reorder makes react-reconciler call `insertBefore` on a child whose
 * Yoga node is already owned by the parent; before the fix this aborted with
 * "Child already has a owner". Deletion must also free Yoga nodes without a
 * use-after-free. Both paths are exercised here.
 */
describe("keyed reorder / deletion (finding #2)", () => {
  const Box = "eve-box";
  const Text = "eve-text";
  const List = ({ order }: { order: string[] }) =>
    h(Box, { flexDirection: "column" }, ...order.map((k) => h(Text, { key: k }, k)));

  it("reorders keyed children without aborting on Yoga ownership", () => {
    const handle = mountForTest(h(List, { order: ["a", "b", "c"] }), { width: 12, height: 6 });
    expect(handle.captureCharFrame()).toBe("a\nb\nc");
    // Each of these reorders re-inserts already-owned Yoga nodes.
    handle.update(h(List, { order: ["c", "a", "b"] }));
    expect(handle.captureCharFrame()).toBe("c\na\nb");
    handle.update(h(List, { order: ["b", "c", "a"] }));
    expect(handle.captureCharFrame()).toBe("b\nc\na");
    handle.unmount();
  });

  it("frees Yoga nodes on deletion without use-after-free", () => {
    const handle = mountForTest(h(List, { order: ["a", "b", "c", "d"] }), { width: 12, height: 6 });
    expect(handle.captureCharFrame()).toBe("a\nb\nc\nd");
    handle.update(h(List, { order: ["a", "d"] })); // delete b, c → freeRecursive
    expect(handle.captureCharFrame()).toBe("a\nd");
    handle.update(h(List, { order: [] })); // delete all remaining
    expect(handle.captureCharFrame().trim()).toBe("");
    // Re-grow after a full clear to prove the container's Yoga node survived.
    handle.update(h(List, { order: ["x", "y"] }));
    expect(handle.captureCharFrame()).toBe("x\ny");
    handle.unmount();
  });
});
