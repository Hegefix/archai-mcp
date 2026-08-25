import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, validateBatch, checkMovable, titleDivergence } from "./index.js";

const run = promisify(execFile);

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content as Array<{ type: string; text: string }>;
  return block[0]?.text ?? "";
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  return (result.structuredContent ?? {}) as Record<string, any>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "archai test"]);
}

async function connect(input: unknown): Promise<Client> {
  const server = await createServer(input as string);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

// --- Pure unit tests ---

describe("checkMovable", () => {
  it("refuses to move the vault's log.md", () => {
    expect(checkMovable("log.md", "notes/log.md")).toMatchObject({ ok: false });
  });

  it("refuses to move a file out of references/", () => {
    const result = checkMovable("references/rfc/spec.txt", "notes/spec.txt");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("references are immutable");
  });

  it("refuses to move a file into references/", () => {
    expect(checkMovable("notes/a.md", "references/a.md")).toMatchObject({ ok: false });
  });

  it("refuses a no-op move", () => {
    expect(checkMovable("a.md", "a.md")).toMatchObject({ ok: false });
  });

  it("allows an ordinary rename", () => {
    expect(checkMovable("notes/a.md", "notes/b.md")).toEqual({ ok: true });
  });
});

describe("titleDivergence", () => {
  it("stays quiet when the title matches the filename", () => {
    const note = "---\ntitle: React Query\n---\nbody\n";
    expect(titleDivergence(note, "concepts/react-query.md")).toBeUndefined();
  });

  // The live case: work/mobile/stack-state.md is titled "GoodHabitz Mobile Stack
  // State". Titles and filenames are decoupled on purpose, so this is a note, not
  // an error, and never an automatic rewrite.
  it("reports a divergence for the caller to judge", () => {
    const note = "---\ntitle: GoodHabitz Mobile Stack State\n---\nbody\n";
    const message = titleDivergence(note, "mobile/stack-state.md");
    expect(message).toContain("GoodHabitz Mobile Stack State");
    expect(message).toContain("not rewritten");
  });

  it("stays quiet for a note with no title", () => {
    expect(titleDivergence("no frontmatter here\n", "a.md")).toBeUndefined();
  });
});

describe("validateBatch", () => {
  const existing = new Set(["a.md", "b.md", "c.md"]);

  it("accepts a clean batch", () => {
    const result = validateBatch([{ from: "a.md", to: "x.md" }], existing);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(validateBatch([], existing)).toMatchObject({ ok: false });
  });

  it("rejects a missing source, naming the entry", () => {
    const result = validateBatch(
      [{ from: "a.md", to: "x.md" }, { from: "gone.md", to: "y.md" }],
      existing
    );
    expect(result).toMatchObject({ ok: false, index: 1 });
  });

  it("rejects two moves targeting the same path", () => {
    const result = validateBatch(
      [{ from: "a.md", to: "x.md" }, { from: "b.md", to: "x.md" }],
      existing
    );
    expect(result).toMatchObject({ ok: false, index: 1 });
    if (!result.ok) expect(result.error).toContain("two moves target");
  });

  it("rejects moving the same source twice", () => {
    const result = validateBatch(
      [{ from: "a.md", to: "x.md" }, { from: "a.md", to: "y.md" }],
      existing
    );
    if (!result.ok) expect(result.error).toContain("moved more than once");
  });

  it("rejects a destination that would overwrite a note staying put", () => {
    const result = validateBatch([{ from: "a.md", to: "c.md" }], existing);
    if (!result.ok) expect(result.error).toContain("not being moved out of the way");
  });

  it("allows a destination whose occupant is moving out in the same batch", () => {
    const result = validateBatch(
      [{ from: "a.md", to: "c.md" }, { from: "c.md", to: "z.md" }],
      existing
    );
    expect(result.ok).toBe(true);
  });

  it("orders a chain so the destination is vacated first", () => {
    const result = validateBatch(
      [{ from: "a.md", to: "c.md" }, { from: "c.md", to: "z.md" }],
      existing
    );
    if (result.ok) expect(result.ordered.map((e) => e.from)).toEqual(["c.md", "a.md"]);
  });

  it("rejects a cycle rather than inventing a temporary name", () => {
    const result = validateBatch(
      [{ from: "a.md", to: "b.md" }, { from: "b.md", to: "a.md" }],
      existing
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("cycle");
  });

  it("rejects two sources sharing a basename, which links cannot disambiguate", () => {
    const result = validateBatch(
      [{ from: "one/dup.md", to: "one/x.md" }, { from: "two/dup.md", to: "two/y.md" }],
      new Set(["one/dup.md", "two/dup.md"])
    );
    expect(result).toMatchObject({ ok: false, index: 1 });
    if (!result.ok) expect(result.error).toContain("share the basename");
  });
});

// --- Integration tests over a real server ---

describe("refactor tools", () => {
  let vaultPath: string;
  let client: Client;

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "archai-refactor-"));
    await mkdir(join(vaultPath, "concepts"), { recursive: true });
    await mkdir(join(vaultPath, "notes"), { recursive: true });
    await initRepo(vaultPath);

    await writeFile(
      join(vaultPath, "concepts/target.md"),
      "---\ntitle: Target\n---\nthe target note\n",
      "utf-8"
    );
    await writeFile(
      join(vaultPath, "notes/citer.md"),
      [
        "---",
        "title: Citer",
        "---",
        "bare [[target]]",
        "prefixed [[concepts/target]]",
        "aliased [[target|The Target]]",
        "anchored [[target#Some Heading]]",
        "in code `[[target]]`",
        "```",
        "[[target]]",
        "```",
        "",
      ].join("\n"),
      "utf-8"
    );
    await writeFile(
      join(vaultPath, "notes/other.md"),
      "---\ntitle: Other\n---\nnothing relevant here\n",
      "utf-8"
    );

    await git(vaultPath, ["add", "-A"]);
    await git(vaultPath, ["commit", "-m", "base"]);
    client = await connect(vaultPath);
  });

  afterEach(async () => {
    await client.close();
    await rm(vaultPath, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  const read = (relative: string) => readFile(join(vaultPath, relative), "utf-8");

  describe("find_backlinks", () => {
    it("finds every link shape pointing at a note, and no code-block ones", async () => {
      const result = await call("find_backlinks", { path: "concepts/target.md" });
      const data = structured(result);
      expect(data["count"]).toBe(4);
      expect(data["files"]).toBe(1);
      expect(data["backlinks"].map((b: any) => b.raw)).toEqual([
        "[[target]]",
        "[[concepts/target]]",
        "[[target|The Target]]",
        "[[target#Some Heading]]",
      ]);
    });

    it("reports line numbers", async () => {
      const data = structured(await call("find_backlinks", { path: "concepts/target.md" }));
      expect(data["backlinks"].map((b: any) => b.line)).toEqual([4, 5, 6, 7]);
    });

    it("accepts a bare basename", async () => {
      const data = structured(await call("find_backlinks", { path: "target" }));
      expect(data["count"]).toBe(4);
    });

    it("returns nothing for a note nobody links to", async () => {
      const data = structured(await call("find_backlinks", { path: "notes/other.md" }));
      expect(data["count"]).toBe(0);
    });

    it("errors on a note that isn't there", async () => {
      const result = await call("find_backlinks", { path: "no-such-note.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("no note matching");
    });
  });

  describe("lint_links", () => {
    it("reports a machine-readable summary with every class counted", async () => {
      const summary = structured(await call("lint_links", {}))["summary"];
      expect(summary).toMatchObject({
        total: 4,
        ok: 4,
        planned: 0,
        external: 0,
        "renamed-candidate": 0,
        broken: 0,
        failures: 0,
        healthy: true,
      });
    });

    it("does not count links inside inline or fenced code", async () => {
      // citer.md has six [[target]] occurrences; two are code and must not appear.
      const summary = structured(await call("lint_links", {}))["summary"];
      expect(summary["total"]).toBe(4);
    });

    it("classifies a dangling link as broken and marks the vault unhealthy", async () => {
      await writeFile(join(vaultPath, "notes/broken.md"), "[[nothing-like-this]]\n", "utf-8");
      const summary = structured(await call("lint_links", {}))["summary"];
      expect(summary).toMatchObject({ broken: 1, failures: 1, healthy: false });
    });

    it("classifies a marked dangling link as planned, not a failure", async () => {
      await writeFile(
        join(vaultPath, "notes/planned.md"),
        "- [[not-written-yet]] <!-- intentional -->\n",
        "utf-8"
      );
      const summary = structured(await call("lint_links", {}))["summary"];
      expect(summary).toMatchObject({ planned: 1, broken: 0, failures: 0, healthy: true });
    });

    it("suggests a target for a near-miss link", async () => {
      await writeFile(join(vaultPath, "notes/typo.md"), "[[concepts/targett]]\n", "utf-8");
      const data = structured(await call("lint_links", {}));
      expect(data["summary"]).toMatchObject({ "renamed-candidate": 1 });
      const finding = data["findings"].find((f: any) => f.class === "renamed-candidate");
      expect(finding).toMatchObject({ suggestion: "concepts/target" });
    });
  });

  describe("rewrite_links", () => {
    it("preserves aliases and headings while retargeting", async () => {
      await call("rewrite_links", { mapping: { target: "renamed" } });
      const citer = await read("notes/citer.md");
      expect(citer).toContain("bare [[renamed]]");
      expect(citer).toContain("prefixed [[renamed]]");
      expect(citer).toContain("aliased [[renamed|The Target]]");
      expect(citer).toContain("anchored [[renamed#Some Heading]]");
    });

    it("leaves links in code alone", async () => {
      await call("rewrite_links", { mapping: { target: "renamed" } });
      const citer = await read("notes/citer.md");
      expect(citer).toContain("in code `[[target]]`");
      expect(citer).toContain("```\n[[target]]\n```");
    });

    it("writes nothing on a dry run but reports the diff", async () => {
      const before = await read("notes/citer.md");
      const result = await call("rewrite_links", {
        mapping: { target: "renamed" },
        dry_run: true,
      });
      expect(await read("notes/citer.md")).toBe(before);
      expect(getText(result)).toContain("Dry run");
      expect(structured(result)["dryRun"]).toBe(true);
    });

    it("reports the same diff a real run applies", async () => {
      const dry = structured(
        await call("rewrite_links", { mapping: { target: "renamed" }, dry_run: true })
      );
      const wet = structured(await call("rewrite_links", { mapping: { target: "renamed" } }));
      expect(wet["rewrites"]).toEqual(dry["rewrites"]);
    });

    it("commits the rewrite as one commit", async () => {
      const before = Number(await git(vaultPath, ["rev-list", "--count", "HEAD"]));
      await call("rewrite_links", { mapping: { target: "renamed" } });
      expect(Number(await git(vaultPath, ["rev-list", "--count", "HEAD"]))).toBe(before + 1);
      expect(await git(vaultPath, ["log", "--format=%s", "-1"])).toContain("rewrite_links:");
    });

    it("reports when nothing matched", async () => {
      const result = await call("rewrite_links", { mapping: { "no-such-note": "x" } });
      expect(getText(result)).toContain("No links matched");
    });

    it("rejects an empty mapping", async () => {
      const result = await call("rewrite_links", { mapping: {} });
      expect(result.isError).toBe(true);
    });
  });

  describe("move", () => {
    it("renames the file and rewrites every inbound link", async () => {
      const result = await call("move", {
        from: "concepts/target.md",
        to: "concepts/renamed.md",
      });
      expect(result.isError).toBeFalsy();
      expect((await stat(join(vaultPath, "concepts/renamed.md"))).isFile()).toBe(true);
      await expect(stat(join(vaultPath, "concepts/target.md"))).rejects.toThrow();

      const citer = await read("notes/citer.md");
      expect(citer).toContain("bare [[renamed]]");
      expect(citer).toContain("aliased [[renamed|The Target]]");
      expect(citer).toContain("anchored [[renamed#Some Heading]]");
      expect(citer).toContain("in code `[[target]]`");
      expect(structured(result)["links"]).toBe(4);
    });

    it("records the change as a rename in git history", async () => {
      await call("move", { from: "concepts/target.md", to: "concepts/renamed.md" });
      const status = await git(vaultPath, [
        "show",
        "--name-status",
        "--format=",
        "--find-renames",
        "HEAD",
      ]);
      expect(status).toMatch(/^R/m);
      expect(status).toContain("concepts/target.md");
      expect(status).toContain("concepts/renamed.md");
    });

    it("lands the rename and its link rewrites in one commit", async () => {
      const before = Number(await git(vaultPath, ["rev-list", "--count", "HEAD"]));
      await call("move", { from: "concepts/target.md", to: "concepts/renamed.md" });
      expect(Number(await git(vaultPath, ["rev-list", "--count", "HEAD"]))).toBe(before + 1);
      expect(await git(vaultPath, ["log", "--format=%s", "-1"])).toBe(
        "move: concepts/target.md -> concepts/renamed.md (+4 links in 1 files)"
      );
      expect(await git(vaultPath, ["status", "--porcelain"])).toBe("");
    });

    it("refuses to overwrite an existing target", async () => {
      const result = await call("move", {
        from: "concepts/target.md",
        to: "notes/other.md",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("already exists — refusing to overwrite");
      // Neither file moved.
      expect((await stat(join(vaultPath, "concepts/target.md"))).isFile()).toBe(true);
      expect(await read("notes/other.md")).toContain("nothing relevant here");
    });

    it("rejects a path that climbs out of the vault, with the existing path-safety error", async () => {
      const result = await call("move", { from: "../outside.md", to: "notes/x.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toBe("Error: Path traversal detected: ../outside.md");
    });

    it("rejects a destination that climbs out of the vault", async () => {
      const result = await call("move", {
        from: "concepts/target.md",
        to: "../escaped.md",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Path traversal detected");
    });

    it("rejects an absolute destination", async () => {
      const result = await call("move", { from: "concepts/target.md", to: "/etc/x.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("must be relative to vault root");
    });

    it("refuses to move log.md", async () => {
      await writeFile(join(vaultPath, "log.md"), "# Log\n", "utf-8");
      const result = await call("move", { from: "log.md", to: "notes/log.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("log.md");
    });

    it("refuses to move a note into references/", async () => {
      const result = await call("move", {
        from: "concepts/target.md",
        to: "references/target.md",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("references are immutable");
    });

    it("rejects an unknown top-level folder unless opted in", async () => {
      const rejected = await call("move", { from: "concepts/target.md", to: "brand-new/t.md" });
      expect(rejected.isError).toBe(true);
      expect(getText(rejected)).toContain("Unknown top-level folder");

      const allowed = await call("move", {
        from: "concepts/target.md",
        to: "brand-new/t.md",
        allowNewTopLevel: true,
      });
      expect(allowed.isError).toBeFalsy();
    });

    it("moves into a folder given as the destination, keeping the filename", async () => {
      const result = await call("move", { from: "concepts/target.md", to: "notes" });
      expect(structured(result)["to"]).toBe("notes/target.md");
    });

    it("adds .md when the destination has no extension", async () => {
      const result = await call("move", { from: "concepts/target.md", to: "notes/renamed" });
      expect(structured(result)["to"]).toBe("notes/renamed.md");
    });

    it("notes a title that no longer matches the filename, without rewriting it", async () => {
      const result = await call("move", {
        from: "concepts/target.md",
        to: "concepts/something-else.md",
      });
      expect(structured(result)["titleNote"]).toContain("Target");
      expect(await read("concepts/something-else.md")).toContain("title: Target");
    });

    it("leaves links alone when update_links is false", async () => {
      const before = await read("notes/citer.md");
      await call("move", {
        from: "concepts/target.md",
        to: "concepts/renamed.md",
        update_links: false,
      });
      expect(await read("notes/citer.md")).toBe(before);
    });

    it("writes nothing on a dry run", async () => {
      const head = await git(vaultPath, ["rev-parse", "HEAD"]);
      const result = await call("move", {
        from: "concepts/target.md",
        to: "concepts/renamed.md",
        dry_run: true,
      });
      expect((await stat(join(vaultPath, "concepts/target.md"))).isFile()).toBe(true);
      expect(structured(result)["links"]).toBe(4);
      expect(await git(vaultPath, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(vaultPath, ["status", "--porcelain"])).toBe("");
    });

    it("rewrites folder-prefixed links when only the folder changes", async () => {
      await call("move", { from: "concepts/target.md", to: "notes/target.md" });
      const citer = await read("notes/citer.md");
      expect(citer).toContain("prefixed [[target]]");
      expect(citer).toContain("bare [[target]]");
    });
  });

  describe("bulk_move", () => {
    it("applies a whole batch as one commit", async () => {
      const before = Number(await git(vaultPath, ["rev-list", "--count", "HEAD"]));
      const result = await call("bulk_move", {
        moves: [
          { from: "concepts/target.md", to: "concepts/renamed.md" },
          { from: "notes/other.md", to: "notes/other-renamed.md" },
        ],
      });
      expect(result.isError).toBeFalsy();
      expect(Number(await git(vaultPath, ["rev-list", "--count", "HEAD"]))).toBe(before + 1);
      expect(await git(vaultPath, ["log", "--format=%s", "-1"])).toContain("bulk_move: 2 notes");
      expect(await read("notes/citer.md")).toContain("bare [[renamed]]");
    });

    it("writes nothing on a dry run", async () => {
      const head = await git(vaultPath, ["rev-parse", "HEAD"]);
      await call("bulk_move", {
        moves: [{ from: "concepts/target.md", to: "concepts/renamed.md" }],
        dry_run: true,
      });
      expect((await stat(join(vaultPath, "concepts/target.md"))).isFile()).toBe(true);
      expect(await git(vaultPath, ["rev-parse", "HEAD"])).toBe(head);
    });

    it("rejects the whole batch when one entry collides, moving nothing", async () => {
      const result = await call("bulk_move", {
        moves: [
          { from: "concepts/target.md", to: "concepts/renamed.md" },
          { from: "notes/other.md", to: "notes/citer.md" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("batch rejected (moves[1])");
      expect((await stat(join(vaultPath, "concepts/target.md"))).isFile()).toBe(true);
      expect(await git(vaultPath, ["status", "--porcelain"])).toBe("");
    });

    it("rolls the whole batch back when a move fails part way through", async () => {
      // A read-only directory makes the second rename fail for real, after the
      // first has already been applied — the exact half-applied state that must
      // not survive.
      const locked = join(vaultPath, "locked");
      await mkdir(locked, { recursive: true });
      await git(vaultPath, ["add", "-A"]);
      await writeFile(join(locked, ".keep"), "", "utf-8");
      await git(vaultPath, ["add", "-A"]);
      await git(vaultPath, ["commit", "-m", "add locked"]);
      await chmod(locked, 0o500);

      try {
        const head = await git(vaultPath, ["rev-parse", "HEAD"]);
        const citerBefore = await read("notes/citer.md");

        const result = await call("bulk_move", {
          moves: [
            { from: "concepts/target.md", to: "concepts/renamed.md" },
            { from: "notes/other.md", to: "locked/other.md" },
          ],
        });

        expect(result.isError).toBe(true);
        expect(getText(result)).toContain("rolled back in full");
        expect(structured(result)).toMatchObject({
          rolledBack: true,
          failedEntry: { from: "notes/other.md", to: "locked/other.md" },
        });

        // Nothing moved, no links rewritten, no commit.
        expect((await stat(join(vaultPath, "concepts/target.md"))).isFile()).toBe(true);
        expect((await stat(join(vaultPath, "notes/other.md"))).isFile()).toBe(true);
        await expect(stat(join(vaultPath, "concepts/renamed.md"))).rejects.toThrow();
        expect(await read("notes/citer.md")).toBe(citerBefore);
        expect(await git(vaultPath, ["rev-parse", "HEAD"])).toBe(head);
      } finally {
        await chmod(locked, 0o700);
      }
    });

    it("rejects a cycle", async () => {
      const result = await call("bulk_move", {
        moves: [
          { from: "concepts/target.md", to: "notes/other.md" },
          { from: "notes/other.md", to: "concepts/target.md" },
        ],
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("cycle");
    });

    it("handles a chain by vacating the destination first", async () => {
      const result = await call("bulk_move", {
        moves: [
          { from: "concepts/target.md", to: "notes/other.md" },
          { from: "notes/other.md", to: "notes/moved-away.md" },
        ],
      });
      expect(result.isError).toBeFalsy();
      expect(await read("notes/other.md")).toContain("the target note");
      expect(await read("notes/moved-away.md")).toContain("nothing relevant here");
    });

    it("rejects a path escape before touching anything", async () => {
      const result = await call("bulk_move", {
        moves: [{ from: "../outside.md", to: "notes/x.md" }],
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Path traversal detected");
    });
  });

  describe("read-only tools stay read-only", () => {
    it("neither find_backlinks nor lint_links commits or writes", async () => {
      const head = await git(vaultPath, ["rev-parse", "HEAD"]);
      await call("find_backlinks", { path: "concepts/target.md" });
      await call("lint_links", {});
      expect(await git(vaultPath, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(vaultPath, ["status", "--porcelain"])).toBe("");
    });
  });
});

describe("lint_links across vaults", () => {
  let repoRoot: string;
  let client: Client;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "archai-crossvault-"));
    await mkdir(join(repoRoot, "tech/concepts"), { recursive: true });
    await mkdir(join(repoRoot, "work/mobile"), { recursive: true });
    await initRepo(repoRoot);

    await writeFile(join(repoRoot, "work/mobile/stack-state.md"), "state\n", "utf-8");
    // A tech note linking to a note that only exists in the work vault.
    await writeFile(
      join(repoRoot, "tech/concepts/a.md"),
      "see [[stack-state]] and [[nothing-at-all]]\n",
      "utf-8"
    );
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "base"]);

    client = await connect({
      vaults: new Map([
        ["tech", join(repoRoot, "tech")],
        ["work", join(repoRoot, "work")],
      ]),
      defaultName: "tech",
    });
  });

  afterEach(async () => {
    await client.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("classifies a cross-vault link as external, never broken", async () => {
    const data = structured(
      await client.callTool({ name: "lint_links", arguments: { vault: "tech" } })
    );
    expect(data["summary"]).toMatchObject({ external: 1, broken: 1 });

    const external = data["findings"].find((f: any) => f.class === "external");
    expect(external).toMatchObject({ target: "stack-state", externalVault: "work" });

    const broken = data["findings"].find((f: any) => f.class === "broken");
    expect(broken).toMatchObject({ target: "nothing-at-all" });
  });

  it("lints every vault when none is named", async () => {
    const data = structured(await client.callTool({ name: "lint_links", arguments: {} }));
    expect(data["summary"]["vaults"]).toEqual(["tech", "work"]);
  });
});
