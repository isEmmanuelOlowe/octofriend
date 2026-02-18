import { useInput } from "ink";

export function useTab(callback: () => void) {
  useInput((_input, key) => {
    if (key.tab && !key.shift) {
      callback();
    }
  });
}
