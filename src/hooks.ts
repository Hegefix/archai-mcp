import { commitVault } from "./git.js";
import { appendLogEntry, type WriteKind } from "./log.js";

export type WriteEvent = {
  tool: WriteKind;
  vaultName: string;
  vaultPath: string;
  /** Vault-relative posix path that was written. */
  path: string;
  /** Note title, when the tool knows one. Used for the log line only. */
  title?: string;
};

/**
 * The single post-write hook: every successful write in `save`, `update` and
 * `save_reference` routes through here, and nowhere else appends to the log or
 * commits.
 *
 * Two side effects, in order — the log entry is written first so it lands in the
 * same commit as the note it describes.
 *
 * Never throws. Bookkeeping is best-effort: a missing git binary, an absent
 * committer identity or an unwritable log must not fail a write that already
 * succeeded. Failures are returned as warnings and logged to stderr (stdout is the
 * MCP transport).
 */
export async function afterWrite(event: WriteEvent): Promise<string[]> {
  const warnings: string[] = [];

  try {
    await appendLogEntry(event.vaultPath, event.tool, event.path, event.title);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    warnings.push(`log.md not updated for [${event.vaultName}] ${event.path}: ${detail}`);
  }

  const commitWarning = await commitVault(
    event.vaultPath,
    `${event.tool}: ${event.path}`
  );
  if (commitWarning !== undefined) warnings.push(commitWarning);

  for (const warning of warnings) {
    console.error(`archai-mcp: ${warning}`);
  }
  return warnings;
}
