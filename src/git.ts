import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import * as path from "node:path";

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
 * Where git can still see a path: on disk, in the index, in HEAD, or nowhere.
 *
 * This matters because `add` and `commit` disagree about what a valid pathspec is.
 * `git add -- <p>` is fatal unless `p` matches the worktree or the index — and
 * after `git mv a b`, `a` matches neither. `git commit -- <p>` is happier: it also
 * accepts a path that only exists in HEAD, and recording that path is precisely
 * what turns the commit into a rename instead of a bare addition.
 */
async function locate(
  vaultPath: string,
  relative: string
): Promise<"disk" | "index" | "head" | undefined> {
  try {
    await stat(path.join(vaultPath, relative));
    return "disk";
  } catch {
    // Not on disk; it may still be a staged or committed deletion.
  }
  try {
    await git(vaultPath, ["ls-files", "--error-unmatch", "--", relative]);
    return "index";
  } catch {
    // Not in the index either.
  }
  try {
    // `ls-files --with-tree` rather than `cat-file -e HEAD:<path>`: cat-file wants a
    // path relative to the REPO root, and these paths are relative to the vault,
    // which is not the repo root whenever several vaults share one repo. ls-files
    // resolves its pathspec against the cwd, so it is correct in both layouts.
    await git(vaultPath, [
      "ls-files",
      "--error-unmatch",
      "--with-tree=HEAD",
      "--",
      relative,
    ]);
    return "head";
  } catch {
    return undefined;
  }
}

/**
 * Split a path list into what `git add` will take and what `git commit` will take.
 *
 * `commit` is the superset: it includes paths that survive only in HEAD, so the
 * disappearance of a moved-from file lands in the commit and git records an `R`
 * rather than an `A` plus a deletion left dangling in the working tree.
 */
async function pathspecs(
  vaultPath: string,
  paths: string[]
): Promise<{ add: string[]; commit: string[] }> {
  const add: string[] = [];
  const commit: string[] = [];
  for (const relative of new Set(paths)) {
    if (relative === "") continue;
    const where = await locate(vaultPath, relative);
    if (where === undefined) continue;
    commit.push(relative);
    if (where !== "head") add.push(relative);
  }
  return { add, commit };
}

/**
 * Stage and commit exactly the paths a tool wrote.
 *
 * The pathspec is the tool's own file list, not `.`, and that is load-bearing
 * twice over:
 *
 *   - Every configured vault here lives inside ONE repo, so an unscoped commit
 *     from the repo root would sweep in whatever else is dirty. On 2026-08-25 that
 *     would have committed the pending deletion of four entire vaults sitting in
 *     the working tree under a message naming a single note.
 *   - Even scoped to one vault, `add -A -- .` pulled in unrelated in-progress
 *     edits in that vault — notes touched in Obsidian since the last write — under
 *     a message naming one file. Listing the written paths explicitly keeps a
 *     commit's contents equal to its message.
 *
 * Resolves to a warning string when the commit could not be made (git missing,
 * no committer identity, index lock, …) and to undefined when a commit was made or
 * there was genuinely nothing to commit. It never rejects — a failed commit must
 * not fail the tool call that triggered it.
 */
export async function commitVault(
  vaultPath: string,
  message: string,
  paths: string[]
): Promise<string | undefined> {
  try {
    await ensureRepo(vaultPath);

    const { add, commit } = await pathspecs(vaultPath, paths);
    if (commit.length === 0) return undefined;

    // `git add` first: a path-limited `git commit` cannot record a file that is
    // not in the index yet, which is every newly created note.
    if (add.length > 0) await git(vaultPath, ["add", "-A", "--", ...add]);

    // Ask before committing: `git commit` exits non-zero on an empty commit, and a
    // no-op write is a normal outcome here, not a failure worth warning about.
    // (`git status` tolerates a pathspec that matches nothing, unlike add/commit.)
    const pending = await git(vaultPath, ["status", "--porcelain", "--", ...commit]);
    if (pending === "") return undefined;

    await git(vaultPath, ["commit", "-m", message, "--", ...commit]);
    return undefined;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `git commit skipped for ${vaultPath}: ${detail}`;
  }
}

/**
 * Move a file inside the vault, preferring `git mv` so the rename is recorded as a
 * rename rather than a delete plus an add — that is what keeps `git log --follow`
 * and the rename history this server's own lint reads working.
 *
 * Paths are vault-relative; git resolves them against the cwd, which is the vault
 * root, so this behaves the same whether the vault owns its repo or sits inside an
 * enclosing one. Falls back to a plain filesystem rename when git cannot do it —
 * an untracked file, or no repo at all — because the move must still happen.
 *
 * Returns how the move was performed. Throws only when the file could not be moved
 * at all; that is a real failure the caller must surface.
 */
export async function gitMove(
  vaultPath: string,
  from: string,
  to: string
): Promise<"git" | "filesystem"> {
  await mkdir(dirname(path.join(vaultPath, to)), { recursive: true });
  try {
    await git(vaultPath, ["mv", "--", from, to]);
    return "git";
  } catch {
    await rename(path.join(vaultPath, from), path.join(vaultPath, to));
    return "filesystem";
  }
}

/**
 * Old basename to current basename for every rename git has recorded under this
 * vault, newest rename winning.
 *
 * `--relative` reports paths against the cwd so the output is vault-relative even
 * in a shared repo, and only basenames are kept: a link's target is a basename, and
 * the folder a note lived in before a restructure is not information a link needs.
 *
 * Chains are followed, so a note renamed a to b and later b to c maps a to c. The
 * log is newest-first, which means a later rename is already in the map by the time
 * its predecessor is read. Returns an empty map when git is unavailable — rename
 * history is an enrichment, not a requirement.
 */
export async function listRenamedBasenames(
  vaultPath: string
): Promise<Map<string, string>> {
  let output: string;
  try {
    output = await git(vaultPath, [
      "log",
      "--diff-filter=R",
      "--name-status",
      "--pretty=format:",
      "--relative",
      "--",
      ".",
    ]);
  } catch {
    return new Map();
  }

  const direct = new Map<string, string>();
  for (const line of output.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3 || !(parts[0] as string).startsWith("R")) continue;
    const from = basename(parts[1] as string).replace(/\.md$/i, "");
    const to = basename(parts[2] as string).replace(/\.md$/i, "");
    if (from === to || from === "" || to === "") continue;
    if (!direct.has(from)) direct.set(from, to);
  }

  const resolved = new Map<string, string>();
  for (const from of direct.keys()) {
    let current = direct.get(from) as string;
    const seen = new Set([from]);
    while (!seen.has(current)) {
      seen.add(current);
      const next = direct.get(current);
      if (next === undefined) break;
      current = next;
    }
    resolved.set(from, current);
  }
  return resolved;
}

/**
 * The commit a vault's repo is currently on, for reporting alongside a batch
 * operation. Undefined when the vault isn't in a repo or the repo has no commits.
 *
 * Deliberately not a rollback mechanism. Undoing a batch by moving HEAD or
 * stashing would reach outside the files this server touched — both configured
 * vaults share one repo, and a vault typically has uncommitted Obsidian edits
 * pending — so rollback is done from a per-file journal instead (see
 * `src/rollback.ts`).
 */
export async function headCommit(vaultPath: string): Promise<string | undefined> {
  try {
    return await git(vaultPath, ["rev-parse", "HEAD"]);
  } catch {
    return undefined;
  }
}

/**
 * Stage the vault's current working tree without committing.
 *
 * Used after a rolled-back operation: `git mv` stages its rename, so once the
 * journal has restored the files on disk the index still describes a move that no
 * longer exists. Re-staging brings the index back in line with the worktree.
 * Scoped to the same explicit paths the operation touched, and silent on failure —
 * this is cleanup, not the caller's business.
 */
export async function stageVault(vaultPath: string, paths: string[]): Promise<void> {
  try {
    const { add } = await pathspecs(vaultPath, paths);
    if (add.length === 0) return;
    await git(vaultPath, ["add", "-A", "--", ...add]);
  } catch {
    // No repo, no git, nothing to keep in sync.
  }
}
