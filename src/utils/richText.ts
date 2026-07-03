export function plainTextFromRichValue(value: unknown): string {
  const parts: string[] = [];

  const visit = (node: unknown) => {
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed) parts.push(trimmed);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    const record = node as Record<string, unknown>;
    if (typeof record.text === "string") {
      const trimmed = record.text.trim();
      if (trimmed) parts.push(trimmed);
      return;
    }

    Object.entries(record).forEach(([key, child]) => {
      if (key !== "type") visit(child);
    });
  };

  visit(value);
  return parts.join(" ").split(/\s+/).filter(Boolean).join(" ");
}
