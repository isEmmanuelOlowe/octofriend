import { describe, expect, it } from "vitest";
import {
  resolveRawSubagentNavSequence,
  resolveSubagentNavShortcut,
} from "./subagent-nav-shortcuts.ts";

describe("resolveSubagentNavShortcut", () => {
  it("ignores shortcuts when there are no live tasks", () => {
    expect(
      resolveSubagentNavShortcut({
        input: ".",
        key: {},
        mode: "tool-waiting",
        taskCount: 0,
      }),
    ).toBeNull();
  });

  it("handles shift+arrow shortcuts", () => {
    expect(
      resolveSubagentNavShortcut({
        input: "",
        key: { shift: true, rightArrow: true },
        mode: "input",
        taskCount: 2,
      }),
    ).toBe("next");

    expect(
      resolveSubagentNavShortcut({
        input: "",
        key: { shift: true, leftArrow: true },
        mode: "input",
        taskCount: 2,
      }),
    ).toBe("prev");
  });

  it("does not treat plain punctuation as navigation while typing", () => {
    expect(
      resolveSubagentNavShortcut({
        input: ".",
        key: {},
        mode: "input",
        taskCount: 2,
      }),
    ).toBeNull();
  });

  it("does not use punctuation fallback anymore", () => {
    expect(
      resolveSubagentNavShortcut({
        input: ">",
        key: {},
        mode: "responding",
        taskCount: 2,
      }),
    ).toBeNull();
  });

  it("ignores non-shift arrows", () => {
    expect(
      resolveSubagentNavShortcut({
        input: "",
        key: { rightArrow: true },
        mode: "input",
        taskCount: 2,
      }),
    ).toBeNull();
  });

  it("parses raw terminal sequences for shift+arrow", () => {
    expect(resolveRawSubagentNavSequence("\x1b[1;2C")).toBe("next");
    expect(resolveRawSubagentNavSequence("\x1b[1;2D")).toBe("prev");
    expect(resolveRawSubagentNavSequence("\x1b[2C")).toBe("next");
    expect(resolveRawSubagentNavSequence("\x1b[2D")).toBe("prev");
    expect(resolveRawSubagentNavSequence("\x1b[67;2u")).toBe("next");
    expect(resolveRawSubagentNavSequence("\x1b[68;2u")).toBe("prev");
    expect(resolveRawSubagentNavSequence("noise\x1b[1;2Cnoise")).toBe("next");
    expect(resolveRawSubagentNavSequence(";2D")).toBe("prev");
    expect(resolveRawSubagentNavSequence("x")).toBeNull();
  });
});
