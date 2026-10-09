/**
 * Coverage of a vault's root `index.md` — the hand-curated map meant to reach
 * every note in the vault.
 *
 * The server never writes the index: which section a note belongs in, and where
 * it sits in a reading chain, is an editorial call. What the server can do is
 * notice a file the map does not reach — at the moment it is written (`save`,
 * `save_reference` say so in their result) and afterwards (`lint_links` reports it
 * as `unindexed`). On 2026-10-08 agents saved eight notes into `work` and none of
 * them reached the index, because the rule lived only in prose nobody re-read.
 *
 * A vault without a root `index.md` has no map, and the check does not apply.
 */

import { glob } from "glob";
import { REFERENCES_DIR, readNoteOrNull, resolveVaultPath, getAllMarkdownFiles } from "./paths.js";
import { LOG_FILE } from "./log.js";
import { resolveTarget, type VaultIndex } from "./lint-candidates.js";
import { scanWikilinks } from "./wikilinks.js";
import { stem } from "./refactor.js";

/** The vault map, at the vault root. */
export const INDEX_NOTE = "index.md";

export type IndexCoverage = {
  /** Notes (vault-relative, `.md` stripped) that a wikilink in index.md resolves to. */
  linked: Set<string>;
  /** The index text as written, for references, which are reached by path. */
  text: string;
};

/**
 * What an index.md reaches, given an index of the vault's notes.
 *
 * Notes are reached by wikilink, resolved the way Obsidian resolves them, so every
 * link shape counts and a link inside code does not. References sit outside the
 * link graph, so the vault lists them by path instead — a markdown link for a
 * markdown file, backticks for anything Obsidian cannot open.
 */
export function indexCoverage(indexContent: string, index: VaultIndex): IndexCoverage {
  const linked = new Set<string>();
  for (const link of scanWikilinks(indexContent)) {
    const resolved = resolveTarget(index, link.target);
    if (resolved !== undefined) linked.add(resolved);
  }
  return { linked, text: indexContent };
}

/** Whether the index reaches `file` (vault-relative, extension included). */
export function isIndexed(coverage: IndexCoverage, file: string): boolean {
  if (file.startsWith(`${REFERENCES_DIR}/`)) {
    return coverage.text.includes(file) || coverage.text.includes(encodeURI(file));
  }
  return coverage.linked.has(stem(file));
}

/** The files the index should reach and does not, sorted. */
export function findUnindexed(files: string[], coverage: IndexCoverage): string[] {
  return files
    .filter((f) => f !== INDEX_NOTE && f !== LOG_FILE && !isIndexed(coverage, f))
    .sort();
}

/** Read the vault's index.md and compute its coverage; null when there is none. */
export async function readIndexCoverage(
  vaultPath: string,
  index: VaultIndex
): Promise<IndexCoverage | null> {
  const content = await readNoteOrNull(resolveVaultPath(vaultPath, INDEX_NOTE));
  return content === null ? null : indexCoverage(content, index);
}

/**
 * Every file the index is expected to reach: each markdown note, plus every file
 * under `references/` whatever its type, since references are often not markdown.
 */
export async function listIndexableFiles(vaultPath: string): Promise<string[]> {
  const references = await glob(`${REFERENCES_DIR}/**/*`, {
    cwd: vaultPath,
    nodir: true,
    posix: true,
  });
  return [...new Set([...(await getAllMarkdownFiles(vaultPath)), ...references])];
}
