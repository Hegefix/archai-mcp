import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
