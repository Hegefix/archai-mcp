import { simpleGit, type SimpleGit } from "simple-git";

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

export interface PushResult {
  pushed: boolean;
  remote: string;
  branch: string;
  error?: string;
}

export interface GitClient {
  isRepo(): Promise<boolean>;
  currentBranch(): Promise<string>;
  status(): Promise<GitStatus>;
  snapshot(message: string): Promise<CommitResult>;
  commit(message: string, allowEmpty?: boolean): Promise<CommitResult>;
  resetHard(sha?: string): Promise<void>;
  push(remote?: string, branch?: string): Promise<PushResult>;
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

  async function currentBranch(): Promise<string> {
    const out = await git.revparse(["--abbrev-ref", "HEAD"]);
    return out.trim();
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

  async function commit(message: string, allowEmpty = false): Promise<CommitResult> {
    const s = await git.status();
    if (s.isClean() && !allowEmpty) {
      return { committed: false, reason: "clean" };
    }
    await git.add(["-A"]);
    const opts = allowEmpty ? ["--allow-empty"] : [];
    const result = await git.commit(message, opts);
    return { committed: true, sha: result.commit };
  }

  async function resetHard(sha?: string): Promise<void> {
    await git.reset(["--hard", sha ?? "HEAD"]);
    await git.raw(["clean", "-fd"]);
  }

  async function push(remote = "origin", branch?: string): Promise<PushResult> {
    let resolvedBranch = branch;
    if (!resolvedBranch) {
      try {
        resolvedBranch = await currentBranch();
      } catch (err) {
        return {
          pushed: false,
          remote,
          branch: "",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    try {
      await git.push(remote, resolvedBranch);
      return { pushed: true, remote, branch: resolvedBranch };
    } catch (err) {
      return {
        pushed: false,
        remote,
        branch: resolvedBranch,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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
    currentBranch,
    status,
    snapshot,
    commit,
    resetHard,
    push,
    isIgnored,
  };
}
