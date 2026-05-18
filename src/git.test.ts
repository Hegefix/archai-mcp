import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { createGit, type GitClient } from "./git.js";

async function initTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "archai-git-test-"));
  const sg = simpleGit(dir);
  await sg.init();
  await sg.addConfig("user.email", "test@archai.local");
  await sg.addConfig("user.name", "Archai Test");
  await sg.addConfig("commit.gpgsign", "false");
  return dir;
}

async function makeInitialCommit(dir: string, file = "init.md", body = "init"): Promise<string> {
  await writeFile(join(dir, file), body, "utf-8");
  const sg = simpleGit(dir);
  await sg.add(["-A"]);
  const r = await sg.commit("init");
  return r.commit;
}

describe("git wrapper", () => {
  let repoPath: string;
  let git: GitClient;

  beforeEach(async () => {
    repoPath = await initTestRepo();
    git = createGit(repoPath);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  describe("isRepo", () => {
    it("returns true for an initialized repo", async () => {
      expect(await git.isRepo()).toBe(true);
    });

    it("returns false for a non-repo directory", async () => {
      const plain = await mkdtemp(join(tmpdir(), "archai-nongit-"));
      try {
        const g = createGit(plain);
        expect(await g.isRepo()).toBe(false);
      } finally {
        await rm(plain, { recursive: true, force: true });
      }
    });
  });

  describe("status", () => {
    it("reports clean after initial commit", async () => {
      await makeInitialCommit(repoPath);
      const s = await git.status();
      expect(s.dirty).toBe(false);
      expect(s.staged).toEqual([]);
      expect(s.modified).toEqual([]);
      expect(s.untracked).toEqual([]);
      expect(s.ahead).toBe(0);
      expect(s.behind).toBe(0);
    });

    it("reports modified, staged, and untracked files", async () => {
      await makeInitialCommit(repoPath, "a.md", "v1");
      const sg = simpleGit(repoPath);

      await writeFile(join(repoPath, "a.md"), "v2", "utf-8");
      await writeFile(join(repoPath, "b.md"), "new staged", "utf-8");
      await sg.add(["b.md"]);
      await writeFile(join(repoPath, "c.md"), "untracked", "utf-8");

      const s = await git.status();
      expect(s.dirty).toBe(true);
      expect(s.modified).toContain("a.md");
      expect(s.staged).toContain("b.md");
      expect(s.untracked).toContain("c.md");
    });
  });

  describe("snapshot", () => {
    it("returns clean reason and does not commit when working tree is clean", async () => {
      await makeInitialCommit(repoPath);
      const r = await git.snapshot("nothing-here");
      expect(r.committed).toBe(false);
      expect(r.reason).toBe("clean");
      expect(r.sha).toBeUndefined();
    });

    it("commits dirty state and returns sha", async () => {
      await writeFile(join(repoPath, "a.md"), "hi", "utf-8");
      const r = await git.snapshot("first");
      expect(r.committed).toBe(true);
      expect(r.sha).toMatch(/^[a-f0-9]{7,40}$/);
    });

    it("captures untracked files in the snapshot", async () => {
      await makeInitialCommit(repoPath, "a.md", "v1");
      await writeFile(join(repoPath, "b.md"), "untracked", "utf-8");

      const r = await git.snapshot("snap");
      expect(r.committed).toBe(true);

      const post = await git.status();
      expect(post.untracked).not.toContain("b.md");
      expect(post.dirty).toBe(false);
    });
  });

  describe("resetHard", () => {
    it("reverts modifications to HEAD", async () => {
      await makeInitialCommit(repoPath, "a.md", "v1");
      await writeFile(join(repoPath, "a.md"), "v2", "utf-8");

      await git.resetHard();

      const content = await readFile(join(repoPath, "a.md"), "utf-8");
      expect(content).toBe("v1");
    });

    it("removes untracked files via clean -fd", async () => {
      await makeInitialCommit(repoPath, "a.md", "v1");
      await writeFile(join(repoPath, "stray.md"), "junk", "utf-8");

      await git.resetHard();

      const s = await git.status();
      expect(s.untracked).not.toContain("stray.md");
    });

    it("resets to a specific sha", async () => {
      const first = await makeInitialCommit(repoPath, "a.md", "v1");
      await writeFile(join(repoPath, "a.md"), "v2", "utf-8");
      const sg = simpleGit(repoPath);
      await sg.add(["-A"]);
      await sg.commit("v2");

      await git.resetHard(first);

      const content = await readFile(join(repoPath, "a.md"), "utf-8");
      expect(content).toBe("v1");
    });
  });

  describe("isIgnored", () => {
    it("returns the subset of paths matched by .gitignore", async () => {
      await writeFile(join(repoPath, ".gitignore"), "secret.md\n", "utf-8");
      await makeInitialCommit(repoPath);
      await writeFile(join(repoPath, "secret.md"), "shh", "utf-8");
      await writeFile(join(repoPath, "open.md"), "ok", "utf-8");

      const ignored = await git.isIgnored(["secret.md", "open.md"]);
      expect(ignored).toEqual(["secret.md"]);
    });

    it("returns empty array when no inputs are ignored", async () => {
      await makeInitialCommit(repoPath);
      const ignored = await git.isIgnored(["any.md", "thing.md"]);
      expect(ignored).toEqual([]);
    });

    it("returns empty array for empty input", async () => {
      expect(await git.isIgnored([])).toEqual([]);
    });
  });
});
