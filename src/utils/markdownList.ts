interface ContinueMarkdownListOptions {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  onChange: (value: string) => void;
  setCursor: (position: number) => void;
}

export function continueMarkdownList({
  value,
  selectionStart,
  selectionEnd,
  onChange,
  setCursor,
}: ContinueMarkdownListOptions): boolean {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const lastLine = before.split("\n").pop() || "";

  const bulletMatch = lastLine.match(/^(\s*)([-*])\s(.*)/);
  if (bulletMatch) {
    const [, indent, marker, content] = bulletMatch;
    if (!content.trim()) {
      const lineStart = before.lastIndexOf("\n") + 1;
      onChange(value.slice(0, lineStart) + after);
      setCursor(lineStart);
      return true;
    }

    const prefix = `${indent}${marker} `;
    onChange(`${before}\n${prefix}${after}`);
    setCursor(selectionStart + 1 + prefix.length);
    return true;
  }

  const numberMatch = lastLine.match(/^(\s*)(\d+)\.\s(.*)/);
  if (numberMatch) {
    const [, indent, number, content] = numberMatch;
    if (!content.trim()) {
      const lineStart = before.lastIndexOf("\n") + 1;
      onChange(value.slice(0, lineStart) + after);
      setCursor(lineStart);
      return true;
    }

    const prefix = `${indent}${Number.parseInt(number, 10) + 1}. `;
    onChange(`${before}\n${prefix}${after}`);
    setCursor(selectionStart + 1 + prefix.length);
    return true;
  }

  return false;
}
