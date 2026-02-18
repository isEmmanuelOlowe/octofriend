import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "../components/text-input.tsx";
import { useColor } from "../theme.ts";
import { InputHistory } from "../input-history/index.ts";

interface Props {
  inputHistory: InputHistory;
  value: string;
  onChange: (s: string) => any;
  onSubmit: () => any;
  vimEnabled?: boolean;
  vimMode?: "NORMAL" | "INSERT";
  setVimMode?: (mode: "NORMAL" | "INSERT") => void;
  focus?: boolean;
  placeholder?: string;
  showBorder?: boolean;
  onInputKey?: (
    input: string,
    key: {
      ctrl?: boolean;
      shift?: boolean;
      meta?: boolean;
      rightArrow?: boolean;
      leftArrow?: boolean;
    },
  ) => boolean;
}

export const InputWithHistory = React.memo((props: Props) => {
  const themeColor = useColor();
  const showBorder = props.showBorder ?? true;
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [originalInput, setOriginalInput] = useState("");

  useInput(
    (input, key) => {
      if (key.upArrow) {
        if (currentIndex === -1) {
          setOriginalInput(props.value);
        }

        const history = props.inputHistory.getCurrentHistory();
        if (history.length === 0) return;

        const newIndex = currentIndex === -1 ? history.length - 1 : Math.max(0, currentIndex - 1);
        setCurrentIndex(newIndex);
        props.onChange(history[newIndex]);
        return;
      }

      if (key.downArrow) {
        const history = props.inputHistory.getCurrentHistory();
        if (currentIndex === -1 || history.length === 0) return;

        if (currentIndex < history.length - 1) {
          const newIndex = currentIndex + 1;
          setCurrentIndex(newIndex);
          props.onChange(history[newIndex]);
        } else {
          // Reset to original input
          setCurrentIndex(-1);
          props.onChange(originalInput);
        }
        return;
      }

      // Reset navigation state when user types anything else
      if (input || key.return || key.escape || key.backspace || key.delete) {
        if (currentIndex !== -1) {
          setCurrentIndex(-1);
          setOriginalInput("");
        }
      }
    },
    { isActive: props.focus ?? true },
  );

  const handleSubmit = () => {
    if (props.value.trim()) {
      props.inputHistory.appendToInputHistory(props.value.trim());
    }

    setCurrentIndex(-1);
    setOriginalInput("");
    props.onSubmit();
  };

  const handleChange = (value: string) => {
    if (currentIndex !== -1) {
      setCurrentIndex(-1);
      setOriginalInput("");
    }
    props.onChange(value);
  };

  return (
    <Box
      width="100%"
      borderLeft={false}
      borderRight={false}
      borderStyle={showBorder ? "single" : undefined}
      borderColor={showBorder ? themeColor : undefined}
      gap={1}
    >
      <Text color="gray">&gt;</Text>
      <TextInput
        value={props.value}
        onChange={handleChange}
        onSubmit={handleSubmit}
        onInputKey={props.onInputKey}
        vimEnabled={props.vimEnabled}
        vimMode={props.vimMode}
        setVimMode={props.setVimMode}
        focus={props.focus ?? true}
        placeholder={props.placeholder}
      />
    </Box>
  );
});
