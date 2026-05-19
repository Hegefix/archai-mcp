import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import matter from "gray-matter";
import { createServer } from "../server.js";

interface SetStatusStructured {
  path: string;
  previous_status: "seedling" | "growing" | "evergreen" | null;
  new_status: "seedling" | "growing" | "evergreen";
  changed: boolean;
}

async function writeNote(
  vault: string,
  rel: string,
  data: Record<string, unknown>,
  body: string
): Promise<void> {
  const full = join(vault, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, matter.stringify(body, data), "utf-8");
}

describe("set_status", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "archai-status-"));
    const server = createServer(vault);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await rm(vault, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await close();
  });

  async function call(args: Record<string, unknown>) {
    return client.callTool({ name: "set_status", arguments: args });
  }

  async function readParsed(rel: string) {
    const raw = await readFile(join(vault, rel), "utf-8");
    return matter(raw);
  }

  it("promotes_seedling_to_growing", async () => {
    await writeNote(
      vault,
      "public/tech/note.md",
      { title: "Note", status: "seedling", created: "2024-01-01" },
      "Body content here."
    );
    const res = await call({ path: "public/tech/note.md", status: "growing" });
    const structured = res.structuredContent as unknown as SetStatusStructured;
    expect(structured).toEqual({
      path: "public/tech/note.md",
      previous_status: "seedling",
      new_status: "growing",
      changed: true,
    });

    const parsed = await readParsed("public/tech/note.md");
    expect(parsed.data["status"]).toBe("growing");
    expect(parsed.data["updated"]).toBe(new Date().toISOString().slice(0, 10));
    expect(parsed.content.trim()).toBe("Body content here.");

    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toBe("Status: public/tech/note.md — seedling → growing");
  });

  it("idempotent_same_status", async () => {
    await writeNote(
      vault,
      "public/tech/note.md",
      { title: "Note", status: "growing", updated: "2020-01-01" },
      "Body."
    );
    const before = await stat(join(vault, "public/tech/note.md"));
    await new Promise((r) => setTimeout(r, 10));

    const res = await call({ path: "public/tech/note.md", status: "growing" });
    const structured = res.structuredContent as unknown as SetStatusStructured;
    expect(structured.changed).toBe(false);
    expect(structured.previous_status).toBe("growing");

    const after = await stat(join(vault, "public/tech/note.md"));
    expect(after.mtimeMs).toBe(before.mtimeMs);

    const parsed = await readParsed("public/tech/note.md");
    expect(parsed.data["updated"]).toBe("2020-01-01");

    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toBe("Status unchanged: public/tech/note.md — already growing");
  });

  it("adds_status_when_missing", async () => {
    await writeNote(
      vault,
      "public/tech/note.md",
      { title: "Note", created: "2024-01-01" },
      "Body."
    );
    const res = await call({ path: "public/tech/note.md", status: "seedling" });
    const structured = res.structuredContent as unknown as SetStatusStructured;
    expect(structured.previous_status).toBeNull();
    expect(structured.changed).toBe(true);

    const parsed = await readParsed("public/tech/note.md");
    expect(parsed.data["status"]).toBe("seedling");

    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toBe("Status set: public/tech/note.md — seedling");
  });

  it("rejects_invalid_status", async () => {
    await writeNote(
      vault,
      "public/tech/note.md",
      { title: "Note", status: "seedling" },
      "Body."
    );
    const before = await readFile(join(vault, "public/tech/note.md"), "utf-8");

    const res = await call({ path: "public/tech/note.md", status: "mature" });
    expect(res.isError).toBe(true);

    const after = await readFile(join(vault, "public/tech/note.md"), "utf-8");
    expect(after).toBe(before);
  });

  it("preserves_other_frontmatter_fields", async () => {
    await writeNote(
      vault,
      "public/tech/note.md",
      {
        title: "Custom",
        created: "2024-01-01",
        status: "seedling",
        tags: ["a", "b"],
        custom_key: "custom value",
        nested: { foo: 1, bar: [2, 3] },
      },
      "Body."
    );
    await call({ path: "public/tech/note.md", status: "evergreen" });
    const parsed = await readParsed("public/tech/note.md");
    expect(parsed.data["title"]).toBe("Custom");
    expect(parsed.data["created"]).toBe("2024-01-01");
    expect(parsed.data["tags"]).toEqual(["a", "b"]);
    expect(parsed.data["custom_key"]).toBe("custom value");
    expect(parsed.data["nested"]).toEqual({ foo: 1, bar: [2, 3] });
    expect(parsed.data["status"]).toBe("evergreen");
  });

  it("rejects_missing_file", async () => {
    const res = await call({ path: "public/tech/missing.md", status: "growing" });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("public/tech/missing.md");
  });

  it("rejects_non_md_path", async () => {
    const res = await call({ path: "public/tech/note.txt", status: "growing" });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain(".md");
  });

  it("preserves_body_verbatim", async () => {
    const body = [
      "# Heading with [[wikilink-target]] inside",
      "",
      "Special chars: — • © λ 🚀 ñ",
      "",
      "```ts",
      "const x: number = 1;",
      "// [[Bad Example]]",
      "```",
      "",
      "Inline `code with [[Anti Pattern]]` here.",
      "",
      "End.",
    ].join("\n");
    await writeNote(
      vault,
      "public/tech/note.md",
      { title: "Note", status: "seedling" },
      body
    );
    await call({ path: "public/tech/note.md", status: "growing" });
    const parsed = await readParsed("public/tech/note.md");
    expect(parsed.content.replace(/^\n/, "").replace(/\n$/, "")).toBe(body);
  });
});
