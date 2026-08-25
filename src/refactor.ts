/**
 * Shared internals for the refactor tools (`find_backlinks`, `lint_links`,
 * `rewrite_links`, `move`, `bulk_move`).
 *
 * Everything here is vault-relative posix paths, `.md` included, matching what
 * `getAllMarkdownFiles` returns and what the tools take and report.
 */

import { readFile, writeFile } from "node:fs/promises";
import { getAllMarkdownFiles, normalizeVaultPath, resolveVaultPath } from "./paths.js";
import { buildVaultIndex, resolveTarget, type VaultIndex } from "./lint-candidates.js";
import { rewriteWikilinks, scanWikilinks, type Wikilink } from "./wikilinks.js";
import type { Journal } from "./rollback.js";
import { LOG_FILE } from "./log.js";
import { REFERENCES_DIR } from "./tools/save_reference.js";

/** Drop a trailing `.md`, case-insensitively. */
export function stem(notePath: string): string {
  return notePath.replace(/\.md$/i, "");
}

export type NoteLinks = {
  file: string;
  content: string;
  links: Wikilink[];
};

/**
 * Every note in the vault with its scanned links.
 *
 * `references/` is excluded: references are raw captured source material, stored
 * verbatim and structurally immutable, so a `[[...]]` inside one is part of the
 * captured bytes and not a claim about this vault's graph. Rewriting one would
 * corrupt the capture.
 */
export async function loadNotes(vaultPath: string): Promise<NoteLinks[]> {
  const files = (await getAllMarkdownFiles(vaultPath)).filter((f) => !isExcluded(f));
  files.sort();

  const notes: NoteLinks[] = [];
  for (const file of files) {
    const content = await readFile(resolveVaultPath(vaultPath, file), "utf-8");
    notes.push({ file, content, links: scanWikilinks(content) });
  }
  return notes;
}

/** Files that are in the vault but are not part of its note graph. */
export function isExcluded(file: string): boolean {
  return file === LOG_FILE || file.startsWith(`${REFERENCES_DIR}/`);
}

/** Index the vault's notes for link resolution. */
export async function buildIndex(name: string, vaultPath: string): Promise<VaultIndex> {
  const files = (await getAllMarkdownFiles(vaultPath)).filter((f) => !isExcluded(f));
  return buildVaultIndex(name, files);
}

/**
 * How a link to `notePath` should be written.
 *
 * The bare basename when it is unambiguous in the vault, the full vault-relative
 * path when several notes share that basename. This is Obsidian's own
 * shortest-unique convention and keeps rewritten links looking like hand-written
 * ones instead of turning every link into a full path.
 */
export function preferredTarget(index: VaultIndex, notePath: string): string {
  const withoutExtension = stem(notePath);
  const basename = withoutExtension.split("/").pop() as string;
  const sharing = index.byBasename.get(basename);
  return sharing !== undefined && sharing.length > 1 ? withoutExtension : basename;
}

export type Backlink = {
  /** Note containing the link. */
  file: string;
  line: number;
  /** The link exactly as written. */
  raw: string;
  target: string;
  alias?: string;
  heading?: string;
};

/**
 * Every link, anywhere in the vault, that resolves to `notePath`.
 *
 * Resolution — not text matching — is what makes this correct across the four
 * shapes a link to one note can take: `[[x]]`, `[[folder/x]]`, `[[x|Label]]` and
 * `[[x#Heading]]` all resolve to the same file and all come back here. A note's
 * links to itself are skipped; they need no rewriting when it moves.
 */
export function findBacklinks(
  notes: NoteLinks[],
  index: VaultIndex,
  notePath: string
): Backlink[] {
  const target = stem(notePath);
  const hits: Backlink[] = [];

  for (const note of notes) {
    if (stem(note.file) === target) continue;
    for (const link of note.links) {
      if (resolveTarget(index, link.target) !== target) continue;
      const hit: Backlink = {
        file: note.file,
        line: link.line,
        raw: link.raw,
        target: link.target,
      };
      if (link.alias !== undefined) hit.alias = link.alias;
      if (link.heading !== undefined) hit.heading = link.heading;
      hits.push(hit);
    }
  }
  return hits;
}

/**
 * Normalize a `rewrite_links` mapping into basename-keyed form.
 *
 * Keys are matched against a link target's **basename**, exact after dropping
 * `.md` — which is what lets one key cover both `[[old]]` and `[[deep/folder/old]]`
 * without the substring matching that would make a bulk rewrite dangerous (a key
 * of `state` has no business rewriting `stack-state` and `state-management`).
 */
export function normalizeMapping(mapping: Record<string, string>): Map<string, string> {
  const normalized = new Map<string, string>();
  for (const [from, to] of Object.entries(mapping)) {
    const key = stem(normalizeVaultPath(from)).split("/").pop() as string;
    normalized.set(key, stem(normalizeVaultPath(to)));
  }
  return normalized;
}

/**
 * A `retarget` function for `rewriteWikilinks` driven by a basename mapping.
 *
 * The replacement is run through `preferredTarget` against `index` so the written
 * form matches the vault's own convention rather than echoing whatever shape the
 * caller passed in the mapping.
 */
export function mappingRetarget(
  mapping: Map<string, string>,
  index: VaultIndex
): (link: Wikilink) => string | undefined {
  return (link) => {
    const basename = stem(link.target).split("/").pop() as string;
    const to = mapping.get(basename);
    return to === undefined ? undefined : preferredTarget(index, to);
  };
}

export type FileRewrite = {
  file: string;
  content: string;
  changes: Array<{ line: number; from: string; to: string }>;
};

/** Format a rewrite set as a readable per-file diff of link text. */
export function formatRewrites(vaultName: string, rewrites: FileRewrite[]): string {
  return rewrites
    .map(
      (r) =>
        `[${vaultName}] ${r.file}\n` +
        r.changes.map((c) => `  ${c.line}: ${c.from} -> ${c.to}`).join("\n")
    )
    .join("\n");
}

/**
 * Work out which files a mapping would change, without touching disk.
 *
 * Shared by `rewrite_links`, `move` and `bulk_move` so a dry run and a real run
 * are computed by exactly the same code — the diff a dry run reports is the diff
 * that gets applied.
 */
export function planRewrites(
  notes: NoteLinks[],
  mapping: Map<string, string>,
  index: VaultIndex
): FileRewrite[] {
  const retarget = mappingRetarget(mapping, index);
  const rewrites: FileRewrite[] = [];

  for (const note of notes) {
    const { content, changes } = rewriteWikilinks(note.content, retarget);
    if (changes.length === 0) continue;
    rewrites.push({
      file: note.file,
      content,
      changes: changes.map((c) => ({ line: c.link.line, from: c.link.raw, to: c.to })),
    });
  }
  return rewrites;
}

/**
 * Write a planned rewrite set.
 *
 * Every file is journaled before it is written, so a failure part way through the
 * set can be undone completely by the caller rather than leaving some notes
 * pointing at the new name and some at the old.
 */
export async function applyRewrites(
  vaultPath: string,
  rewrites: FileRewrite[],
  journal: Journal
): Promise<void> {
  for (const rewrite of rewrites) {
    const absolute = resolveVaultPath(vaultPath, rewrite.file);
    await journal.record(absolute);
    await writeFile(absolute, rewrite.content, "utf-8");
  }
}

/** `+N links in M files`, the phrasing used in commit messages and tool output. */
export function describeRewrites(rewrites: FileRewrite[]): string {
  const links = rewrites.reduce((sum, r) => sum + r.changes.length, 0);
  return `+${links} links in ${rewrites.length} files`;
}
