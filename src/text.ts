export function toKebabCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Local calendar date, not UTC: a note saved at 01:00 CEST belongs to that day,
 * not to the previous one.
 */
export function todayISO(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().split("T")[0] as string;
}

export function findWordPositions(content: string, words: string[]): Map<string, number[]> {
  const lowerContent = content.toLowerCase();
  const positions = new Map<string, number[]>();
  for (const word of words) {
    const indices: number[] = [];
    let idx = 0;
    while ((idx = lowerContent.indexOf(word, idx)) !== -1) {
      indices.push(idx);
      idx += word.length;
    }
    positions.set(word, indices);
  }
  return positions;
}

export function extractBestSnippet(
  content: string,
  words: string[],
  windowSize = 150
): string {
  const positions = findWordPositions(content, words);
  const allPositions: number[] = [];
  for (const indices of positions.values()) {
    allPositions.push(...indices);
  }
  if (allPositions.length === 0) return "";
  allPositions.sort((a, b) => a - b);

  let bestStart = allPositions[0] ?? 0;
  let bestCount = 0;

  for (const anchor of allPositions) {
    const windowEnd = anchor + windowSize;
    let count = 0;
    for (const pos of allPositions) {
      if (pos >= anchor && pos <= windowEnd) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestStart = anchor;
    }
  }

  const start = Math.max(0, bestStart - 20);
  const end = Math.min(content.length, start + windowSize);
  let snippet = content.slice(start, end).replace(/\n/g, " ");
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet;
}
