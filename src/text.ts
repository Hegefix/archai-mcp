export function toKebabCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function todayISO(): string {
  return new Date().toISOString().split("T")[0] as string;
}

export type VaultFolderInfo = {
  name: string;
  topLevelFolders: string[];
};

/** Human-readable summary of each vault's real top-level folders, for tool description text. */
export function describeVaultLayouts(vaults: VaultFolderInfo[]): string {
  return vaults
    .map((v) =>
      v.topLevelFolders.length > 0
        ? `${v.name}: ${v.topLevelFolders.join(", ")}`
        : `${v.name}: flat, no subfolders`
    )
    .join("; ");
}

export function firstTopLevelFolder(vault: VaultFolderInfo | undefined): string | undefined {
  return vault?.topLevelFolders[0];
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
