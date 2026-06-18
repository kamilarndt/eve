import { describe, expect, it } from "vitest";

import {
  fingerprintConsoleArguments,
  fingerprintRemoteConsoleArguments,
} from "./console-correlation.js";

describe("console correlation", () => {
  it("gives local and inspector arguments the same stable fingerprint", () => {
    const local = ["dynamic echo", 42, { nested: true }, ["one"]];
    const remote = [
      { type: "string", value: "dynamic echo" },
      { type: "number", value: 42 },
      { className: "Object", description: "Object", type: "object" },
      { className: "Array", description: "Array(1)", subtype: "array", type: "object" },
    ];

    expect(fingerprintRemoteConsoleArguments(remote)).toBe(fingerprintConsoleArguments(local));
  });
});
