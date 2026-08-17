import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/** Root of the work tree governing `dir`, or undefined when `dir` isn't in a repo. */
export async function findRepoRoot(dir: string): Promise<string | undefined> {
  try {
    const root = await git(dir, ["rev-parse", "--show-toplevel"]);
    return root === "" ? undefined : root;
  } catch {
    return undefined;
  }
}

/**
 * Make sure the vault is versioned and report which repo owns it.
 *
 * A repo that already governs the vault — the vault's own `.git`, or an enclosing
 * one such as a notes monorepo holding several vaults — is reused as-is. `git init`
 * runs only when no repo governs the vault at all, so existing history is never
 * re-rooted or rewritten.
 */
export async function ensureRepo(vaultPath: string): Promise<string> {
  const existing = await findRepoRoot(vaultPath);
  if (existing !== undefined) return existing;

  await git(vaultPath, ["init"]);
  const created = await findRepoRoot(vaultPath);
  if (created === undefined) {
    throw new Error(`git init succeeded but ${vaultPath} is still not a work tree`);
  }
  return created;
}

/**
 * Stage and commit everything under the vault root.
 *
 * Both commands carry an explicit `.` pathspec so the commit stays scoped to this
 * vault: when several vaults share one enclosing repo, a write to one of them must
 * not sweep up another vault's unrelated working-tree changes.
 *
 * Resolves to a warning string when the commit could not be made (git missing,
 * no committer identity, index lock, …) and to undefined when a commit was made or
 * there was genuinely nothing to commit. It never rejects — a failed commit must
 * not fail the tool call that triggered it.
 */
export async function commitVault(
  vaultPath: string,
  message: string
): Promise<string | undefined> {
  try {
    await ensureRepo(vaultPath);
    await git(vaultPath, ["add", "-A", "--", "."]);

    // Ask before committing: `git commit` exits non-zero on an empty commit, and a
    // no-op write is a normal outcome here, not a failure worth warning about.
    const pending = await git(vaultPath, ["status", "--porcelain", "--", "."]);
    if (pending === "") return undefined;

    await git(vaultPath, ["commit", "-m", message, "--", "."]);
    return undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `git commit skipped for ${vaultPath}: ${detail}`;
  }
}
