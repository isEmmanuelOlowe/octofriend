type KeyLike = {
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
};

type Direction = "next" | "prev";

export function resolveSubagentNavShortcut(args: {
  input: string;
  key: KeyLike;
  mode: string;
  taskCount: number;
}): Direction | null {
  const { key, mode, taskCount } = args;
  if (taskCount <= 0) return null;

  // Intentional simplification: only Shift+Left / Shift+Right switch views.
  // This avoids punctuation shortcuts that interfere with normal typing.
  if (mode === "menu") return null;
  if (key.shift === true && key.rightArrow === true) return "next";
  if (key.shift === true && key.leftArrow === true) return "prev";
  return null;
}

export function resolveRawSubagentNavSequence(sequence: string): Direction | null {
  // Handle fragmented tails seen in some terminals when CSI chunks are split.
  if (sequence.endsWith(";2C")) return "next";
  if (sequence.endsWith(";2D")) return "prev";

  // Shift+Right / Shift+Left arrow across common terminal encodings.
  if (sequence.includes("\x1b[1;2C") || sequence.includes("\x1b[2C")) return "next";
  if (sequence.includes("\x1b[1;2D") || sequence.includes("\x1b[2D")) return "prev";

  if (sequence.includes("\x1b[67;2u")) return "next";
  if (sequence.includes("\x1b[68;2u")) return "prev";

  return null;
}
