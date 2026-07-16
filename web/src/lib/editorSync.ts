export type TextChange = {
  from: number;
  to: number;
  insert: string;
};

/**
 * Reduce an external document update to the smallest contiguous replacement.
 * CodeMirror can then map the local selection through the unchanged prefix and
 * suffix instead of treating every collaborative update as a whole-file swap.
 */
export function minimalTextChange(current: string, next: string): TextChange | null {
  if (current === next) return null;

  const sharedLimit = Math.min(current.length, next.length);
  let prefixLength = 0;
  while (prefixLength < sharedLimit && current[prefixLength] === next[prefixLength]) {
    prefixLength += 1;
  }

  let currentSuffixStart = current.length;
  let nextSuffixStart = next.length;
  while (
    currentSuffixStart > prefixLength &&
    nextSuffixStart > prefixLength &&
    current[currentSuffixStart - 1] === next[nextSuffixStart - 1]
  ) {
    currentSuffixStart -= 1;
    nextSuffixStart -= 1;
  }

  return {
    from: prefixLength,
    to: currentSuffixStart,
    insert: next.slice(prefixLength, nextSuffixStart)
  };
}
