import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "./server.js";

const execFileP = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout;
}

async function initGitInVault(vault: string): Promise<void> {
  await git(vault, "init");
  await git(vault, "config", "user.email", "test@archai.local");
  await git(vault, "config", "user.name", "Archai Test");
  await git(vault, "config", "commit.gpgsign", "false");
}

async function gitAddCommit(vault: string, message: string): Promise<void> {
  await git(vault, "add", "-A");
  await git(vault, "commit", "-m", message);
}

async function gitLogCount(vault: string): Promise<number> {
  const out = await git(vault, "rev-list", "--count", "HEAD");
  return parseInt(out.trim(), 10);
}

async function gitLatestMessage(vault: string): Promise<string> {
  return (await git(vault, "log", "-1", "--pretty=%s")).trim();
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  return client.callTool({ name, arguments: args });
}

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content as Array<{ type: string; text: string }>;
  return block[0]?.text ?? "";
}

async function setupVault(): Promise<{ vault: string; client: Client; close: () => Promise<void> }> {
  const vault = await mkdtemp(join(tmpdir(), "archai-refactor-test-"));
  const server = createServer(vault);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    vault,
    client,
    close: async () => {
      await client.close();
      await rm(vault, { recursive: true, force: true });
    },
  };
}

async function writeNote(vault: string, relPath: string, body: string): Promise<void> {
  const full = join(vault, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body, "utf-8");
}

describe("find_backlinks", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, client, close } = await setupVault());
  });

  afterEach(async () => {
    await close();
  });

  it("finds wikilink backlinks across the vault", async () => {
    await writeNote(vault, "a.md", "see [[target]] here");
    await writeNote(vault, "b.md", "also [[target]]");
    await writeNote(vault, "c.md", "nothing relevant");
    await writeNote(vault, "target.md", "# target");

    const r = await callTool(client, "find_backlinks", { target: "target" });
    const sc = r.structuredContent as {
      target: string;
      resolved_files: string[];
      backlinks: Array<{ path: string; link_type: string; raw: string }>;
    };
    expect(sc.target).toBe("target");
    expect(sc.resolved_files).toEqual(["target.md"]);
    expect(sc.backlinks).toHaveLength(2);
    expect(sc.backlinks.map((b) => b.path).sort()).toEqual(["a.md", "b.md"]);
    expect(sc.backlinks.every((b) => b.link_type === "wikilink")).toBe(true);
  });

  it("accepts a path as target and collapses to basename", async () => {
    await writeNote(vault, "public/tech/target.md", "# t");
    await writeNote(vault, "other.md", "see [[target]]");
    const r = await callTool(client, "find_backlinks", {
      target: "public/tech/target.md",
    });
    const sc = r.structuredContent as { target: string; backlinks: unknown[] };
    expect(sc.target).toBe("target");
    expect(sc.backlinks).toHaveLength(1);
  });

  it("excludes wikilinks inside code blocks", async () => {
    await writeNote(vault, "a.md", "real [[target]]\n\n```\n[[target]]\n```\nand `[[target]]`");
    await writeNote(vault, "target.md", "");
    const r = await callTool(client, "find_backlinks", { target: "target" });
    const sc = r.structuredContent as { backlinks: unknown[] };
    expect(sc.backlinks).toHaveLength(1);
  });

  it("preserves alias in raw backlink text", async () => {
    await writeNote(vault, "a.md", "click [[target|display name]]");
    await writeNote(vault, "target.md", "");
    const r = await callTool(client, "find_backlinks", { target: "target" });
    const sc = r.structuredContent as { backlinks: Array<{ raw: string }> };
    expect(sc.backlinks[0]!.raw).toBe("[[target|display name]]");
  });

  it("detects markdown-style links to the target", async () => {
    await writeNote(vault, "a.md", "click [here](./target.md)");
    await writeNote(vault, "target.md", "");
    const r = await callTool(client, "find_backlinks", { target: "target" });
    const sc = r.structuredContent as {
      backlinks: Array<{ link_type: string; raw: string }>;
    };
    expect(sc.backlinks).toHaveLength(1);
    expect(sc.backlinks[0]!.link_type).toBe("markdown");
    expect(sc.backlinks[0]!.raw).toBe("[here](./target.md)");
  });

  it("returns empty backlinks and resolved_files for unknown target", async () => {
    await writeNote(vault, "a.md", "see [[other]]");
    const r = await callTool(client, "find_backlinks", { target: "missing" });
    const sc = r.structuredContent as {
      resolved_files: string[];
      backlinks: unknown[];
    };
    expect(sc.resolved_files).toEqual([]);
    expect(sc.backlinks).toEqual([]);
  });

  it("reports ambiguity when multiple files share the basename", async () => {
    await writeNote(vault, "public/note.md", "");
    await writeNote(vault, "private/note.md", "");
    await writeNote(vault, "ref.md", "see [[note]]");
    const r = await callTool(client, "find_backlinks", { target: "note" });
    const sc = r.structuredContent as { resolved_files: string[] };
    expect(sc.resolved_files.sort()).toEqual([
      "private/note.md",
      "public/note.md",
    ]);
    expect(getText(r)).toContain("Ambiguous");
  });

  it("includes self-references", async () => {
    await writeNote(vault, "target.md", "see [[target]] (self)");
    const r = await callTool(client, "find_backlinks", { target: "target" });
    const sc = r.structuredContent as { backlinks: Array<{ path: string }> };
    expect(sc.backlinks).toHaveLength(1);
    expect(sc.backlinks[0]!.path).toBe("target.md");
  });
});

describe("move", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, client, close } = await setupVault());
  });

  afterEach(async () => {
    await close();
  });

  it("renames within the same folder (basename unchanged): no link updates needed", async () => {
    await writeNote(vault, "public/a.md", "see [[b]]");
    await writeNote(vault, "public/b.md", "body");
    const r = await callTool(client, "move", {
      from: "public/b.md",
      to: "public/sub/b.md",
    });
    const sc = r.structuredContent as {
      moved: boolean;
      link_updates: unknown[];
    };
    expect(sc.moved).toBe(true);
    expect(sc.link_updates).toEqual([]);
    const a = await readFile(join(vault, "public/a.md"), "utf-8");
    expect(a).toBe("see [[b]]"); // wikilinks resolve by basename, no change needed
    await expect(stat(join(vault, "public/b.md"))).rejects.toThrow();
    await expect(stat(join(vault, "public/sub/b.md"))).resolves.toBeDefined();
  });

  it("rewrites wikilinks in backlink files when basename changes", async () => {
    await writeNote(vault, "a.md", "see [[old]] and also [[old|alias]]");
    await writeNote(vault, "b.md", "ref to [[old#heading]]");
    await writeNote(vault, "old.md", "body");

    const r = await callTool(client, "move", {
      from: "old.md",
      to: "new.md",
    });
    const sc = r.structuredContent as {
      link_updates: Array<{ path: string; old: string; new: string }>;
    };
    expect(sc.link_updates).toHaveLength(3);
    const a = await readFile(join(vault, "a.md"), "utf-8");
    expect(a).toBe("see [[new]] and also [[new|alias]]");
    const b = await readFile(join(vault, "b.md"), "utf-8");
    expect(b).toBe("ref to [[new#heading]]");
  });

  it("rewrites markdown-style links pointing at the old path", async () => {
    await writeNote(vault, "a.md", "click [link](./old.md)");
    await writeNote(vault, "old.md", "body");

    const r = await callTool(client, "move", {
      from: "old.md",
      to: "new.md",
    });
    const sc = r.structuredContent as { link_updates: unknown[] };
    expect(sc.link_updates).toHaveLength(1);
    const a = await readFile(join(vault, "a.md"), "utf-8");
    expect(a).toBe("click [link](new.md)");
  });

  it("recomputes outgoing markdown links inside the moved note", async () => {
    await writeNote(vault, "public/scratch/a.md", "see [other](./b.md)");
    await writeNote(vault, "public/scratch/b.md", "body");

    const r = await callTool(client, "move", {
      from: "public/scratch/a.md",
      to: "public/concepts/a.md",
    });
    expect((r.structuredContent as { moved: boolean }).moved).toBe(true);
    const moved = await readFile(
      join(vault, "public/concepts/a.md"),
      "utf-8"
    );
    expect(moved).toContain("(../scratch/b.md)");
  });

  it("refuses when destination basename collides without allow_ambiguity", async () => {
    await writeNote(vault, "private/note.md", "private one");
    await writeNote(vault, "public/note.md", "public one");
    await writeNote(vault, "old.md", "to move");

    const r = await callTool(client, "move", {
      from: "old.md",
      to: "archive/note.md",
    });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("already used by");
    await expect(stat(join(vault, "old.md"))).resolves.toBeDefined();
  });

  it("proceeds with warning when allow_ambiguity is true", async () => {
    await writeNote(vault, "private/note.md", "private one");
    await writeNote(vault, "old.md", "to move");
    const r = await callTool(client, "move", {
      from: "old.md",
      to: "archive/note.md",
      allow_ambiguity: true,
    });
    const sc = r.structuredContent as { warnings: string[]; moved: boolean };
    expect(sc.moved).toBe(true);
    expect(sc.warnings.length).toBeGreaterThan(0);
  });

  it("refuses when destination exists without overwrite", async () => {
    await writeNote(vault, "a.md", "one");
    await writeNote(vault, "b.md", "two");
    const r = await callTool(client, "move", { from: "a.md", to: "b.md" });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("already exists");
  });

  it("overwrites when overwrite=true", async () => {
    await writeNote(vault, "a.md", "from-content");
    await writeNote(vault, "b.md", "to-content");
    const r = await callTool(client, "move", {
      from: "a.md",
      to: "b.md",
      overwrite: true,
    });
    const sc = r.structuredContent as { moved: boolean };
    expect(sc.moved).toBe(true);
    const b = await readFile(join(vault, "b.md"), "utf-8");
    expect(b).toBe("from-content");
  });

  it("is a no-op when from === to", async () => {
    await writeNote(vault, "x.md", "body");
    const r = await callTool(client, "move", { from: "x.md", to: "x.md" });
    const sc = r.structuredContent as { moved: boolean };
    expect(sc.moved).toBe(false);
    await expect(stat(join(vault, "x.md"))).resolves.toBeDefined();
  });

  it("dry_run returns the plan without writing", async () => {
    await writeNote(vault, "a.md", "see [[old]]");
    await writeNote(vault, "old.md", "body");
    const r = await callTool(client, "move", {
      from: "old.md",
      to: "new.md",
      dry_run: true,
    });
    const sc = r.structuredContent as {
      moved: boolean;
      link_updates: unknown[];
      dry_run: boolean;
    };
    expect(sc.dry_run).toBe(true);
    expect(sc.moved).toBe(false);
    expect(sc.link_updates).toHaveLength(1);
    await expect(stat(join(vault, "old.md"))).resolves.toBeDefined();
    await expect(stat(join(vault, "new.md"))).rejects.toThrow();
  });

  it("errors when from doesn't exist", async () => {
    const r = await callTool(client, "move", {
      from: "missing.md",
      to: "elsewhere.md",
    });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("not found");
  });

  it("errors when paths don't end in .md", async () => {
    await writeNote(vault, "x.md", "");
    const r = await callTool(client, "move", { from: "x.md", to: "y.txt" });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("must end in .md");
  });

  it("bumps frontmatter `updated` on the moved note only", async () => {
    const today = new Date().toISOString().split("T")[0];
    await writeNote(
      vault,
      "old.md",
      "---\ntitle: T\nupdated: 2020-01-01\n---\nbody"
    );
    await writeNote(
      vault,
      "ref.md",
      "---\ntitle: R\nupdated: 2020-01-01\n---\nsee [[old]]"
    );
    await callTool(client, "move", { from: "old.md", to: "new.md" });
    const moved = await readFile(join(vault, "new.md"), "utf-8");
    // YAML may quote the value; both forms encode the same date.
    expect(moved).toMatch(new RegExp(`updated:\\s*['"]?${today}['"]?`));
    const ref = await readFile(join(vault, "ref.md"), "utf-8");
    expect(ref).toContain("updated: 2020-01-01");
    expect(ref).toContain("[[new]]");
  });

  it("rewrites self-referential markdown link inside the moved note", async () => {
    await writeNote(vault, "old.md", "[me](./old.md) and body");
    await callTool(client, "move", { from: "old.md", to: "new.md" });
    const moved = await readFile(join(vault, "new.md"), "utf-8");
    expect(moved).toContain("(new.md)");
    expect(moved).not.toContain("(./old.md)");
    expect(moved).not.toContain("(old.md)");
  });

  it("update_links=false skips backlink updates", async () => {
    await writeNote(vault, "a.md", "see [[old]]");
    await writeNote(vault, "old.md", "body");
    const r = await callTool(client, "move", {
      from: "old.md",
      to: "new.md",
      update_links: false,
    });
    const sc = r.structuredContent as { link_updates: unknown[] };
    expect(sc.link_updates).toEqual([]);
    const a = await readFile(join(vault, "a.md"), "utf-8");
    expect(a).toBe("see [[old]]");
  });
});

describe("bulk_move", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, client, close } = await setupVault());
  });

  afterEach(async () => {
    await close();
  });

  it("rejects snapshot:false without unsafe_no_snapshot", async () => {
    const r = await callTool(client, "bulk_move", {
      operations: [{ from: "a.md", to: "b.md" }],
      snapshot: false,
    });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("unsafe_no_snapshot");
  });

  it("errors with non-git message when default snapshot path used in a non-git vault", async () => {
    await writeNote(vault, "a.md", "v");
    const r = await callTool(client, "bulk_move", {
      operations: [{ from: "a.md", to: "b.md" }],
    });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("not a git repository");
    expect(getText(r)).toContain("unsafe_no_snapshot");
  });

  it("moves three files with cross-links atomically", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "public/scratch/a.md", "see [[b]] and [[c]]");
    await writeNote(vault, "public/scratch/b.md", "ref to [[c]]");
    await writeNote(vault, "public/scratch/c.md", "leaf");
    await writeNote(vault, "ref.md", "external [[a]] and [[b]]");
    await gitAddCommit(vault, "init");

    const r = await callTool(client, "bulk_move", {
      operations: [
        { from: "public/scratch/a.md", to: "public/concepts/a.md" },
        { from: "public/scratch/b.md", to: "public/concepts/b.md" },
        { from: "public/scratch/c.md", to: "public/concepts/c.md" },
      ],
    });
    const sc = r.structuredContent as {
      success: boolean;
      results: Array<{ moved: boolean }>;
      total_link_updates: number;
      rolled_back: boolean;
      snapshot_sha?: string;
    };
    expect(sc.success).toBe(true);
    expect(sc.results.every((x) => x.moved)).toBe(true);
    expect(sc.rolled_back).toBe(false);
    // Basenames didn't change, so wikilinks don't need rewriting.
    expect(sc.total_link_updates).toBe(0);

    for (const f of ["a", "b", "c"]) {
      await expect(
        stat(join(vault, `public/scratch/${f}.md`))
      ).rejects.toThrow();
      await expect(
        stat(join(vault, `public/concepts/${f}.md`))
      ).resolves.toBeDefined();
    }
    // ref.md still references basenames unchanged
    const ref = await readFile(join(vault, "ref.md"), "utf-8");
    expect(ref).toContain("[[a]]");
  });

  it("rewrites wikilinks when basenames change", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "old1.md", "see [[old2]]");
    await writeNote(vault, "old2.md", "leaf");
    await writeNote(vault, "ref.md", "use [[old1]] then [[old2]]");

    const r = await callTool(client, "bulk_move", {
      operations: [
        { from: "old1.md", to: "new1.md" },
        { from: "old2.md", to: "new2.md" },
      ],
    });
    const sc = r.structuredContent as {
      success: boolean;
      total_link_updates: number;
    };
    expect(sc.success).toBe(true);
    expect(sc.total_link_updates).toBeGreaterThanOrEqual(3);

    const ref = await readFile(join(vault, "ref.md"), "utf-8");
    expect(ref).toBe("use [[new1]] then [[new2]]");
    const moved1 = await readFile(join(vault, "new1.md"), "utf-8");
    expect(moved1).toContain("[[new2]]");
  });

  it("orders chained moves topologically (A→B, B→C)", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "A.md", "A-content");
    await writeNote(vault, "B.md", "B-content");

    const r = await callTool(client, "bulk_move", {
      operations: [
        { from: "A.md", to: "B.md" },
        { from: "B.md", to: "C.md" },
      ],
    });
    const sc = r.structuredContent as { success: boolean };
    expect(sc.success).toBe(true);
    const cContent = await readFile(join(vault, "C.md"), "utf-8");
    expect(cContent).toBe("B-content");
    const bContent = await readFile(join(vault, "B.md"), "utf-8");
    expect(bContent).toBe("A-content");
    await expect(stat(join(vault, "A.md"))).rejects.toThrow();
  });

  it("rejects cycles", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "A.md", "A");
    await writeNote(vault, "B.md", "B");
    const r = await callTool(client, "bulk_move", {
      operations: [
        { from: "A.md", to: "B.md" },
        { from: "B.md", to: "A.md" },
      ],
    });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("Cycle");
  });

  it("rejects duplicate destinations", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "A.md", "");
    await writeNote(vault, "B.md", "");
    const r = await callTool(client, "bulk_move", {
      operations: [
        { from: "A.md", to: "X.md" },
        { from: "B.md", to: "X.md" },
      ],
    });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("Duplicate destination");
  });

  it("rejects git-ignored from paths", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "secret.md", "shh");
    await writeFile(join(vault, ".gitignore"), "secret.md\n", "utf-8");
    await git(vault, "add", ".gitignore");
    await git(vault, "commit", "-m", "ignore");

    const r = await callTool(client, "bulk_move", {
      operations: [{ from: "secret.md", to: "moved.md" }],
    });
    expect(r.isError).toBe(true);
    expect(getText(r)).toContain("git-ignored");
  });

  it("captures untracked from files in the snapshot and rolls back on error", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "existing.md", "v1");
    await gitAddCommit(vault, "init");

    // Untracked from file
    await writeNote(vault, "fresh.md", "untracked");

    // We need to induce a failure. Easiest: make the destination collide with
    // an unwritable parent. Approach: pre-create a file at a nested-parent
    // location used by `to`, blocking mkdir.
    await writeFile(join(vault, "blocker"), "in-the-way", "utf-8");

    const r = await callTool(client, "bulk_move", {
      operations: [{ from: "fresh.md", to: "blocker/moved.md" }],
    });
    expect(r.isError).toBe(true);
    const sc = r.structuredContent as { rolled_back: boolean };
    expect(sc.rolled_back).toBe(true);

    // fresh.md should be restored
    const fresh = await readFile(join(vault, "fresh.md"), "utf-8");
    expect(fresh).toBe("untracked");
    await expect(stat(join(vault, "blocker/moved.md"))).rejects.toThrow();
  });

  it("dry_run returns the plan without writing or committing", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "a.md", "[[b]]");
    await writeNote(vault, "b.md", "leaf");
    await gitAddCommit(vault, "init");

    const r = await callTool(client, "bulk_move", {
      operations: [{ from: "b.md", to: "renamed.md" }],
      dry_run: true,
    });
    const sc = r.structuredContent as {
      success: boolean;
      total_link_updates: number;
      dry_run: boolean;
    };
    expect(sc.success).toBe(true);
    expect(sc.dry_run).toBe(true);
    expect(sc.total_link_updates).toBe(1);
    await expect(stat(join(vault, "b.md"))).resolves.toBeDefined();
    await expect(stat(join(vault, "renamed.md"))).rejects.toThrow();
    expect(await gitLogCount(vault)).toBe(1);
  });

  it("returns a single snapshot commit; does not auto-followup", async () => {
    await initGitInVault(vault);
    await writeNote(vault, "a.md", "");
    await gitAddCommit(vault, "init");
    // Make state dirty so the snapshot will actually commit:
    await writeNote(vault, "extra.md", "");

    const r = await callTool(client, "bulk_move", {
      operations: [{ from: "a.md", to: "renamed.md" }],
    });
    const sc = r.structuredContent as { snapshot_sha?: string };
    expect(sc.snapshot_sha).toBeDefined();
    expect(await gitLogCount(vault)).toBe(2); // init + snapshot
  });

  it("unsafe_no_snapshot=true works without git", async () => {
    await writeNote(vault, "a.md", "[[b]]");
    await writeNote(vault, "b.md", "leaf");
    const r = await callTool(client, "bulk_move", {
      operations: [{ from: "b.md", to: "renamed.md" }],
      unsafe_no_snapshot: true,
    });
    const sc = r.structuredContent as { success: boolean };
    expect(sc.success).toBe(true);
    const a = await readFile(join(vault, "a.md"), "utf-8");
    expect(a).toBe("[[renamed]]");
  });
});

describe("rewrite_links", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, client, close } = await setupVault());
  });

  afterEach(async () => {
    await close();
  });

  it("rewrites wikilinks across multiple files preserving aliases and headings", async () => {
    await writeNote(vault, "a.md", "see [[old]] and [[old|alt]] and [[old#H]]");
    await writeNote(vault, "b.md", "and embed ![[old]]");

    const r = await callTool(client, "rewrite_links", {
      from: "old",
      to: "new",
    });
    const sc = r.structuredContent as { updates: unknown[] };
    expect(sc.updates).toHaveLength(4);

    const a = await readFile(join(vault, "a.md"), "utf-8");
    expect(a).toBe("see [[new]] and [[new|alt]] and [[new#H]]");
    const b = await readFile(join(vault, "b.md"), "utf-8");
    expect(b).toBe("and embed ![[new]]");
  });

  it("rewrites markdown-style links whose basename matches", async () => {
    await writeNote(vault, "a.md", "click [x](./old.md) or [y](sub/old.md)");
    const r = await callTool(client, "rewrite_links", {
      from: "old",
      to: "new",
    });
    expect((r.structuredContent as { updates: unknown[] }).updates).toHaveLength(2);
    const a = await readFile(join(vault, "a.md"), "utf-8");
    expect(a).toBe("click [x](new.md) or [y](sub/new.md)");
  });

  it("dry_run does not write", async () => {
    await writeNote(vault, "a.md", "see [[old]]");
    const r = await callTool(client, "rewrite_links", {
      from: "old",
      to: "new",
      dry_run: true,
    });
    const sc = r.structuredContent as { updates: unknown[]; dry_run: boolean };
    expect(sc.dry_run).toBe(true);
    expect(sc.updates).toHaveLength(1);
    const a = await readFile(join(vault, "a.md"), "utf-8");
    expect(a).toBe("see [[old]]");
  });

  it("leaves wikilinks inside code blocks alone", async () => {
    await writeNote(vault, "a.md", "real [[old]] code `[[old]]`");
    await callTool(client, "rewrite_links", { from: "old", to: "new" });
    const a = await readFile(join(vault, "a.md"), "utf-8");
    expect(a).toBe("real [[new]] code `[[old]]`");
  });
});

describe("end-to-end: full refactor flow", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, client, close } = await setupVault());
  });

  afterEach(async () => {
    await close();
  });

  it("reorganizes a cross-linked set of notes with one snapshot commit and no auto-followup", async () => {
    // 1. Build the fixture: three cross-linked notes + an external reference.
    //    One destination basename changes so we exercise wikilink rewriting.
    await writeNote(
      vault,
      "public/scratch/alpha.md",
      "---\ntitle: Alpha\nupdated: 2020-01-01\n---\nrefers to [[beta]] and [[gamma]] and an md link [g](./gamma.md)"
    );
    await writeNote(
      vault,
      "public/scratch/beta.md",
      "---\ntitle: Beta\nupdated: 2020-01-01\n---\nrefers to [[gamma]]"
    );
    await writeNote(
      vault,
      "public/scratch/gamma.md",
      "---\ntitle: Gamma\nupdated: 2020-01-01\n---\nleaf"
    );
    await writeNote(
      vault,
      "external.md",
      "see [[alpha]] and [[gamma|the leaf]]"
    );

    // 2. git init + initial commit.
    await initGitInVault(vault);
    await gitAddCommit(vault, "initial vault state");

    // 3. Pre-condition: clean status (verified directly via git).
    expect((await git(vault, "status", "--porcelain")).trim()).toBe("");

    // Dirty the tree so the snapshot will produce an actual commit.
    // (A clean tree → snapshot skips committing; rollback still works
    // via reset to HEAD, but we want to assert against the SHA here.)
    await writeNote(vault, "scratchpad.md", "throwaway");

    // 4. Bulk move + rename gamma → delta (basename change).
    const bulk = await callTool(client, "bulk_move", {
      operations: [
        {
          from: "public/scratch/alpha.md",
          to: "public/concepts/alpha.md",
        },
        {
          from: "public/scratch/beta.md",
          to: "public/concepts/beta.md",
        },
        {
          from: "public/scratch/gamma.md",
          to: "public/concepts/delta.md",
        },
      ],
    });
    const bsc = bulk.structuredContent as {
      success: boolean;
      results: Array<{ moved: boolean }>;
      total_link_updates: number;
      snapshot_sha: string;
      rolled_back: boolean;
    };
    expect(bsc.success).toBe(true);
    expect(bsc.rolled_back).toBe(false);
    expect(bsc.results.length).toBe(3);
    expect(bsc.results.every((r) => r.moved)).toBe(true);
    expect(bsc.snapshot_sha).toMatch(/^[a-f0-9]{7,40}$/);
    // gamma → delta means 3 wikilink rewrites (alpha references gamma,
    // beta references gamma, external references gamma|alias) plus the
    // markdown-style link from alpha.
    expect(bsc.total_link_updates).toBeGreaterThanOrEqual(4);

    // 5. Verify wikilinks resolve at the new locations.
    const movedAlpha = await readFile(
      join(vault, "public/concepts/alpha.md"),
      "utf-8"
    );
    expect(movedAlpha).toContain("[[beta]]");
    expect(movedAlpha).toContain("[[delta]]");
    // The outgoing markdown link was recomputed relative to the new
    // location (gamma moved to delta in the same dir, so it's "delta.md"):
    expect(movedAlpha).toContain("(delta.md)");

    const movedBeta = await readFile(
      join(vault, "public/concepts/beta.md"),
      "utf-8"
    );
    expect(movedBeta).toContain("[[delta]]");

    const external = await readFile(join(vault, "external.md"), "utf-8");
    expect(external).toBe("see [[alpha]] and [[delta|the leaf]]");

    // 6. Original locations are gone, scratch folder no longer has these notes.
    for (const f of [
      "public/scratch/alpha.md",
      "public/scratch/beta.md",
      "public/scratch/gamma.md",
    ]) {
      await expect(stat(join(vault, f))).rejects.toThrow();
    }

    // 7. The moved files have a bumped `updated` field; backlink-only
    //    notes (external.md) do not.
    const today = new Date().toISOString().split("T")[0];
    expect(movedAlpha).toMatch(new RegExp(`updated:\\s*['"]?${today}['"]?`));
    expect(external).not.toContain("updated:"); // never had frontmatter, no bump

    // 8. Exactly one new commit (snapshot) — bulk_move does NOT auto-followup.
    expect(await gitLogCount(vault)).toBe(2);
    expect(await gitLatestMessage(vault)).toBe(
      "archai: pre-refactor snapshot"
    );
  });
});
