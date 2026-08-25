import { commitVault } from "./git.js";
import { appendLogEntry, LOG_FILE, type WriteKind } from "./log.js";

export type WriteEvent = {
  tool: WriteKind;
  vaultName: string;
  vaultPath: string;
  /** Vault-relative posix path that was written. */
  path: string;
  /** Note title, when the tool knows one. Used for the log line only. */
  title?: string;
  /**
   * Append to the vault's `log.md`. Off unless the vault opted in — see
   * `isLogEnabled`. The git commit happens either way.
   */
  log?: boolean;
  /**
   * Override the commit message. Defaults to `<tool>: <path>`. Multi-file
   * operations use this to land as one commit describing the whole change rather
   * than one commit per file touched.
   */
  message?: string;
  /**
   * Vault-relative paths this write actually touched, used as the commit's
   * pathspec. Defaults to `[path]`. Multi-file operations MUST pass this — both
   * because `path` is only a representative for them, and because the commit is
   * scoped to exactly these files (see `commitVault`).
   */
  paths?: string[];
};

/**
 * The single post-write hook: every successful write routes through here, and
 * nowhere else appends to the log or commits.
 *
 * Two side effects, in order — the log entry, when the vault opted into one, is
 * written first so it lands in the same commit as the note it describes.
 *
 * Never throws. Bookkeeping is best-effort: a missing git binary, an absent
 * committer identity or an unwritable log must not fail a write that already
 * succeeded. Failures are returned as warnings and logged to stderr (stdout is the
 * MCP transport).
 */
export async function afterWrite(event: WriteEvent): Promise<string[]> {
  const warnings: string[] = [];

  const paths = [...(event.paths ?? [event.path])];

  if (event.log === true) {
    try {
      await appendLogEntry(event.vaultPath, event.tool, event.path, event.title);
      // The log entry belongs in the same commit as what it describes, so it has
      // to be in the pathspec too.
      paths.push(LOG_FILE);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnings.push(`log.md not updated for [${event.vaultName}] ${event.path}: ${detail}`);
    }
  }

  const commitWarning = await commitVault(
    event.vaultPath,
    event.message ?? `${event.tool}: ${event.path}`,
    paths
  );
  if (commitWarning !== undefined) warnings.push(commitWarning);

  for (const warning of warnings) {
    console.error(`archai-mcp: ${warning}`);
  }
  return warnings;
}
