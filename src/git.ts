import { simpleGit, type SimpleGit } from "simple-git";

// Internal infrastructure for bulk_move's snapshot/rollback. Not exposed as
// MCP tools — users run `git status` / `git commit` / `git push` themselves
// in their terminal.

export interface GitStatus {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  reason?: "clean";
}

export interface GitClient {
  isRepo(): Promise<boolean>;
  status(): Promise<GitStatus>;
  snapshot(message: string): Promise<CommitResult>;
  resetHard(sha?: string): Promise<void>;
  isIgnored(relativePaths: string[]): Promise<string[]>;
}

export function createGit(vaultRoot: string): GitClient {
  const git: SimpleGit = simpleGit(vaultRoot);

  async function isRepo(): Promise<boolean> {
    try {
      return await git.checkIsRepo();
    } catch {
      return false;
    }
  }

  async function status(): Promise<GitStatus> {
    const s = await git.status();
    return {
      branch: s.current ?? "HEAD",
      dirty: !s.isClean(),
      ahead: s.ahead,
      behind: s.behind,
      staged: [...s.staged],
      modified: [...s.modified],
      untracked: [...s.not_added],
    };
  }

  async function snapshot(message: string): Promise<CommitResult> {
    const s = await git.status();
    if (s.isClean()) {
      return { committed: false, reason: "clean" };
    }
    await git.add(["-A"]);
    const result = await git.commit(message);
    return { committed: true, sha: result.commit };
  }

  async function resetHard(sha?: string): Promise<void> {
    await git.reset(["--hard", sha ?? "HEAD"]);
    await git.raw(["clean", "-fd"]);
  }

  async function isIgnored(relativePaths: string[]): Promise<string[]> {
    if (relativePaths.length === 0) return [];
    try {
      const out = await git.raw(["check-ignore", "--", ...relativePaths]);
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (err) {
      // git check-ignore exits with code 1 when no paths match (none ignored).
      const message = err instanceof Error ? err.message : String(err);
      if (/exit code 1/i.test(message) || /exit code: 1/i.test(message)) {
        return [];
      }
      throw err;
    }
  }

  return {
    isRepo,
    status,
    snapshot,
    resetHard,
    isIgnored,
  };
}
