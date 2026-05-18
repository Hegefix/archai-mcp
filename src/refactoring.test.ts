import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";

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
