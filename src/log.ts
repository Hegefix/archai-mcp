import { readFile, writeFile } from "node:fs/promises";
import { resolveVaultPath } from "./paths.js";
import { todayISO } from "./text.js";

/** One activity log per vault, at the vault root. */
export const LOG_FILE = "log.md";

export type WriteKind = "save" | "update" | "save_reference";

const LABELS: Record<WriteKind, string> = {
  save: "Creation",
  update: "Update",
  save_reference: "Reference",
};

/**
 * One log line for a write. Notes are linked as wikilinks (extension dropped, the
 * way Obsidian writes them); references are raw files that may not be markdown at
 * all, so they are logged as plain paths.
 */
export function formatLogEntry(kind: WriteKind, path: string, title?: string): string {
  const target =
    kind === "save_reference" ? path : `[[${path.replace(/\.md$/, "")}]]`;
  const suffix = title && title.trim() !== "" ? ` — ${title}` : "";
  return `* **${LABELS[kind]}**: ${target}${suffix}`;
}

/**
 * Insert `entry` at the end of today's `## YYYY-MM-DD` section, creating the file
 * skeleton or the day heading when either is missing. Days accumulate top to
 * bottom; hand-written content outside today's section is left byte-for-byte alone.
 */
export function appendUnderToday(existing: string, today: string, entry: string): string {
  const heading = `## ${today}`;

  if (existing.trim() === "") {
    return `# Log\n\n${heading}\n\n${entry}\n`;
  }

  const lines = existing.replace(/\s+$/, "").split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === heading);

  if (headingIndex === -1) {
    return `${lines.join("\n")}\n\n${heading}\n\n${entry}\n`;
  }

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if ((lines[i] as string).startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }

  // Skip back over the blank lines separating this section from the next one so the
  // entry lands after the last real line of today's section.
  let insertAt = sectionEnd;
  while (insertAt > headingIndex + 1 && (lines[insertAt - 1] as string).trim() === "") {
    insertAt--;
  }

  const inserted = insertAt === headingIndex + 1 ? ["", entry] : [entry];
  lines.splice(insertAt, 0, ...inserted);
  return `${lines.join("\n")}\n`;
}

/** Append one entry to the vault's `log.md`, creating it on first write. */
export async function appendLogEntry(
  vaultPath: string,
  kind: WriteKind,
  path: string,
  title?: string
): Promise<void> {
  const logPath = resolveVaultPath(vaultPath, LOG_FILE);
  let existing = "";
  try {
    existing = await readFile(logPath, "utf-8");
  } catch {
    // No log yet — appendUnderToday writes the skeleton.
  }
  const updated = appendUnderToday(existing, todayISO(), formatLogEntry(kind, path, title));
  await writeFile(logPath, updated, "utf-8");
}
