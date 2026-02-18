import { Box, DOMElement, measureElement, useStdin, Text, BoxProps } from "ink";
import React, { useEffect, useState, useRef, useCallback, createContext } from "react";
import { useColor } from "../theme.ts";

// https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Extended-coordinates
// SGR 1006 mode is more reliable than basic 1000 mode
const MOUSE_PATTERNS = {
  // SGR format: \x1b[<button;col;row;M or m
  // M = pressed, m = released
  SGR: /\x1b\[<(\d+);(\d+);(\d+)([Mm])/,
  // URXVT format: \x1b[button;col;rowM
  URXVT: /\x1b\[(\d+);(\d+);(\d+)M/,
  // UTF8 format: \x1b[M<button_byte><col_byte><row_byte>
  UTF8: /\x1b\[M(.)(.)(.)/,
} as const;

const SCROLL_DIRECTIONS = {
  SCROLL_UP: "SCROLL_UP",
  SCROLL_DOWN: "SCROLL_DOWN",
} as const;

type ScrollDirection = (typeof SCROLL_DIRECTIONS)[keyof typeof SCROLL_DIRECTIONS];

const MOUSE_BUTTONS = {
  // SGR 1006 mode button values
  SGR: {
    [SCROLL_DIRECTIONS.SCROLL_UP]: 64,
    [SCROLL_DIRECTIONS.SCROLL_DOWN]: 65,
  },
  // URXVT uses same values but with offset
  URXVT: {
    [SCROLL_DIRECTIONS.SCROLL_UP]: 96,
    [SCROLL_DIRECTIONS.SCROLL_DOWN]: 97,
  },
};

// Mouse tracking escape sequences
// 1006 = SGR extended coordinates (more reliable)
// 1000 = basic mouse tracking
const MOUSE_TRACKING = {
  ENABLE: "\x1b[?1006h\x1b[?1000h",
  DISABLE: "\x1b[?1000l\x1b[?1006l",
} as const;

export interface ScrollViewProps extends React.PropsWithChildren {
  height: number;
}

export const IsScrollableContext = createContext(false);

export function ScrollView({ height, children }: ScrollViewProps) {
  const [innerHeight, setInnerHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const innerRef = useRef<DOMElement>(null);
  const { stdin, setRawMode } = useStdin();

  const handleElementSize = useCallback(() => {
    if (!innerRef.current) return;
    const dimensions = measureElement(innerRef.current);
    setInnerHeight(dimensions.height);
    if (shouldAutoScroll) {
      const maxScroll = Math.max(0, dimensions.height - height);
      setScrollTop(maxScroll);
    }
  }, [shouldAutoScroll]);

  const isScrollable = innerHeight > height;
  const maxScroll = Math.max(0, innerHeight - height);
  const scrollPercentage = maxScroll > 0 ? Math.round((scrollTop / maxScroll) * 100) : 0;

  const handleScroll = useCallback(
    (direction: ScrollDirection) => {
      setScrollTop(prev => {
        const delta = direction === SCROLL_DIRECTIONS.SCROLL_UP ? -3 : 3;
        const newScrollTop = prev + delta;
        const maxScroll = Math.max(0, innerHeight - height);
        const scrollPercentage = maxScroll > 0 ? Math.round((newScrollTop / maxScroll) * 100) : 0;
        if (scrollPercentage >= 99) setShouldAutoScroll(true);
        else setShouldAutoScroll(false);
        return Math.max(0, Math.min(newScrollTop, maxScroll));
      });
    },
    [innerHeight, height],
  );

  useEffect(() => {
    const handleResize = () => {
      setTimeout(handleElementSize, 0);
    };
    process.stdout.on("resize", handleResize);

    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, [handleElementSize]);

  // Mouse wheel scrolling support
  useEffect(() => {
    if (!stdin || !setRawMode || !isScrollable) {
      return;
    }

    // Enable mouse tracking
    setRawMode(true);
    process.stdout.write(MOUSE_TRACKING.ENABLE);

    const handleData = (data: Buffer) => {
      const str = data.toString();

      // Try SGR 1006 format first (most reliable)
      const sgrMatch = str.match(MOUSE_PATTERNS.SGR);
      if (sgrMatch) {
        const button = parseInt(sgrMatch[1], 10);
        if (button === MOUSE_BUTTONS.SGR.SCROLL_UP) {
          handleScroll(SCROLL_DIRECTIONS.SCROLL_UP);
        } else if (button === MOUSE_BUTTONS.SGR.SCROLL_DOWN) {
          handleScroll(SCROLL_DIRECTIONS.SCROLL_DOWN);
        }
        return;
      }

      // Try URXVT format
      const urxvtMatch = str.match(MOUSE_PATTERNS.URXVT);
      if (urxvtMatch) {
        const button = parseInt(urxvtMatch[1], 10);
        if (button === MOUSE_BUTTONS.URXVT.SCROLL_UP) {
          handleScroll(SCROLL_DIRECTIONS.SCROLL_UP);
        } else if (button === MOUSE_BUTTONS.URXVT.SCROLL_DOWN) {
          handleScroll(SCROLL_DIRECTIONS.SCROLL_DOWN);
        }
        return;
      }

      // Try UTF8 format
      const utf8Match = str.match(MOUSE_PATTERNS.UTF8);
      if (utf8Match) {
        const button = utf8Match[1].charCodeAt(0);
        if (button === MOUSE_BUTTONS.URXVT.SCROLL_UP) {
          handleScroll(SCROLL_DIRECTIONS.SCROLL_UP);
        } else if (button === MOUSE_BUTTONS.URXVT.SCROLL_DOWN) {
          handleScroll(SCROLL_DIRECTIONS.SCROLL_DOWN);
        }
        return;
      }
    };

    stdin.on("data", handleData);

    return () => {
      process.stdout.write(MOUSE_TRACKING.DISABLE);
      stdin.off("data", handleData);
      setRawMode(false);
    };
  }, [stdin, setRawMode, isScrollable, handleScroll]);

  useEffect(() => {
    const timer = setTimeout(handleElementSize, 0);
    return () => clearTimeout(timer);
  }, [height, handleElementSize]);

  useEffect(() => {
    const timer = setTimeout(handleElementSize, 0);
    return () => clearTimeout(timer);
  }, [children, handleElementSize]);

  const SCROLL_UI_COLOR = useColor();
  const scrollableStyles: BoxProps = {
    borderStyle: "single",
    borderTop: false,
    borderBottom: false,
    borderRight: false,
    paddingLeft: 1,
    borderColor: SCROLL_UI_COLOR,
  };

  return (
    <IsScrollableContext.Provider value={isScrollable}>
      <Box flexDirection="column">
        <Box
          height={isScrollable ? height : undefined}
          flexDirection="column"
          flexShrink={0}
          overflow="hidden"
          overflowY={isScrollable ? undefined : "hidden"}
          {...(isScrollable && scrollableStyles)}
        >
          <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-scrollTop}>
            {children}
          </Box>
        </Box>
        {isScrollable && (
          <Box justifyContent="flex-start">
            <Text color={SCROLL_UI_COLOR} dimColor>
              {scrollPercentage}% {scrollTop > 0 ? "↑" : ""}
              {scrollTop < maxScroll ? "↓" : ""}
            </Text>
          </Box>
        )}
      </Box>
    </IsScrollableContext.Provider>
  );
}
