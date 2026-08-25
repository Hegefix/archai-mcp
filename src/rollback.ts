/**
 * Per-file undo journal for multi-file writes.
 *
 * `bulk_move` has to be atomic: a half-applied rename wave — some notes moved,
 * some inbound links rewritten to targets that don't exist yet — is worse than a
 * rejected batch, because the caller can no longer tell which half happened.
 *
 * Rollback is done from a journal rather than from git (`reset --hard`, `stash`,
 * `checkout .`) on purpose. Both configured vaults live inside one repo, and a
 * vault normally carries uncommitted Obsidian edits; any git-level undo would
 * revert work this server never touched. The journal restores exactly the paths
 * that were recorded and nothing else.
 *
 * Usage: record a path *before* mutating it, every time. Recording reads the
 * current bytes (or notes the file's absence), and only the first record for a
 * path counts — so re-recording a file that this operation already modified
 * cannot overwrite the pristine copy.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

type Entry = { content: string } | { absent: true };

export type Journal = {
  /** Capture `absolutePath`'s current state. Idempotent per path. */
  record(absolutePath: string): Promise<void>;
  /** Restore every recorded path. Returns a warning per path that could not be restored. */
  rollback(): Promise<string[]>;
  /** How many distinct paths are journaled. */
  size(): number;
};

export function createJournal(): Journal {
  const entries = new Map<string, Entry>();

  return {
    async record(absolutePath: string): Promise<void> {
      if (entries.has(absolutePath)) return;
      try {
        entries.set(absolutePath, { content: await readFile(absolutePath, "utf-8") });
      } catch {
        entries.set(absolutePath, { absent: true });
      }
    },

    async rollback(): Promise<string[]> {
      const warnings: string[] = [];
      for (const [absolutePath, entry] of entries) {
        try {
          if ("absent" in entry) {
            await rm(absolutePath, { force: true });
          } else {
            await mkdir(dirname(absolutePath), { recursive: true });
            await writeFile(absolutePath, entry.content, "utf-8");
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          warnings.push(`could not restore ${absolutePath}: ${detail}`);
        }
      }
      return warnings;
    },

    size(): number {
      return entries.size;
    },
  };
}
