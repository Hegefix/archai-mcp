import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import {
  createServer,
  toKebabCase,
  inferFolder,
  findWordPositions,
  extractBestSnippet,
  resolveVaultPath,
} from "./index.js";

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content as Array<{ type: string; text: string }>;
  return block[0]?.text ?? "";
}

// --- Unit tests ---

describe("toKebabCase", () => {
  it("converts title to kebab-case", () => {
    expect(toKebabCase("React Native Fabric")).toBe("react-native-fabric");
  });

  it("strips special characters", () => {
    expect(toKebabCase("What's New in v2.0?")).toBe("whats-new-in-v20");
  });

  it("collapses multiple spaces and dashes", () => {
    expect(toKebabCase("  too   many--dashes  ")).toBe("too-many-dashes");
  });

  it("handles empty string", () => {
    expect(toKebabCase("")).toBe("");
  });
});

describe("inferFolder", () => {
  it("returns private/personal for personal content", () => {
    expect(inferFolder("My career goals for 2025")).toBe("private/personal");
  });

  it("returns public/tech for technical content", () => {
    expect(inferFolder("React hooks patterns")).toBe("public/tech");
  });

  it("defaults to public/tech for neutral content", () => {
    expect(inferFolder("Some random note")).toBe("public/tech");
  });
});

describe("findWordPositions", () => {
  it("finds all positions of each word", () => {
    const result = findWordPositions("foo bar foo baz foo", ["foo"]);
    expect(result.get("foo")).toEqual([0, 8, 16]);
  });

  it("is case-insensitive", () => {
    const result = findWordPositions("Hello HELLO hello", ["hello"]);
    expect(result.get("hello")).toEqual([0, 6, 12]);
  });

  it("returns empty array for missing words", () => {
    const result = findWordPositions("no match here", ["xyz"]);
    expect(result.get("xyz")).toEqual([]);
  });
});

describe("extractBestSnippet", () => {
  it("returns snippet around best word cluster", () => {
    const content = "A".repeat(200) + " react native fabric " + "B".repeat(200);
    const snippet = extractBestSnippet(content, ["react", "native"]);
    expect(snippet).toContain("react native");
  });

  it("returns empty for no matches", () => {
    expect(extractBestSnippet("nothing here", ["xyz"])).toBe("");
  });
});

describe("resolveVaultPath", () => {
  it("resolves a relative path", () => {
    expect(resolveVaultPath("/vault", "public/note.md")).toBe(
      "/vault/public/note.md"
    );
  });

  it("throws on path traversal", () => {
    expect(() => resolveVaultPath("/vault", "../etc/passwd")).toThrow(
      "Path traversal detected"
    );
  });
});

// --- Integration tests via MCP client ---

describe("MCP tools", () => {
  let vaultPath: string;
  let client: Client;

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: args });
  }

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "archai-test-"));
    const server = createServer(vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(vaultPath, { recursive: true, force: true });
  });

  describe("save", () => {
    it("creates a note with frontmatter", async () => {
      const result = await callTool("save", {
        title: "Test Note",
        content: "Hello world",
        folder: "public/tech",
        force: true,
      });
      expect(getText(result)).toContain("Created: public/tech/test-note.md");

      const filePath = join(vaultPath, "public/tech/test-note.md");
      const raw = await readFile(filePath, "utf-8");
      const parsed = matter(raw);
      expect(parsed.data["title"]).toBe("Test Note");
      expect(parsed.data["status"]).toBe("seedling");
      expect(parsed.content.trim()).toBe("Hello world");
    });

    it("creates tags in frontmatter", async () => {
      await callTool("save", {
        title: "Tagged Note",
        content: "Content",
        folder: "public/tech",
        tags: ["ts", "mcp"],
        force: true,
      });
      const raw = await readFile(
        join(vaultPath, "public/tech/tagged-note.md"),
        "utf-8"
      );
      const parsed = matter(raw);
      expect(parsed.data["tags"]).toEqual(["ts", "mcp"]);
    });

    it("infers public/tech for technical content", async () => {
      const result = await callTool("save", {
        title: "React Hooks",
        content: "useState patterns",
        force: true,
      });
      expect(getText(result)).toContain("public/tech");
    });

    it("infers private/personal for personal content", async () => {
      const result = await callTool("save", {
        title: "My Goals",
        content: "career growth and personal development goals",
        force: true,
      });
      expect(getText(result)).toContain("private/personal");
    });

    it("warns about duplicates when force is not set", async () => {
      await callTool("save", {
        title: "Duplicate Test",
        content: "Original note",
        folder: "public/tech",
        force: true,
      });
      const result = await callTool("save", {
        title: "Duplicate Test",
        content: "Another note",
        folder: "public/tech",
      });
      expect(getText(result)).toContain("potentially similar");
    });
  });

  describe("read", () => {
    it("reads an existing note", async () => {
      await callTool("save", {
        title: "Read Me",
        content: "File content here",
        folder: "public/tech",
        force: true,
      });
      const result = await callTool("read", {
        path: "public/tech/read-me.md",
      });
      expect(getText(result)).toContain("File content here");
    });

    it("returns error for missing file", async () => {
      const result = await callTool("read", {
        path: "does/not/exist.md",
      });
      expect(getText(result)).toContain("Error: file not found");
      expect(result.isError).toBe(true);
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await callTool("save", {
        title: "React Native Guide",
        content: "A guide to react native architecture",
        folder: "public/tech",
        force: true,
      });
      await callTool("save", {
        title: "TypeScript Tips",
        content: "Advanced typescript patterns for react apps",
        folder: "public/tech",
        force: true,
      });
      await callTool("save", {
        title: "Cooking Pasta",
        content: "Boil water and add pasta",
        folder: "private/personal",
        force: true,
      });
    });

    it("finds notes by single word", async () => {
      const result = await callTool("search", { query: "react" });
      const text = getText(result);
      expect(text).toContain("react-native-guide.md");
      expect(text).toContain("typescript-tips.md");
      expect(text).not.toContain("cooking");
    });

    it("requires all words to match", async () => {
      const result = await callTool("search", { query: "react native" });
      const text = getText(result);
      expect(text).toContain("react-native-guide.md");
      expect(text).not.toContain("typescript-tips.md");
    });

    it("ranks filename matches higher", async () => {
      const result = await callTool("search", { query: "react" });
      const text = getText(result);
      const guidePos = text.indexOf("react-native-guide.md");
      const tipsPos = text.indexOf("typescript-tips.md");
      expect(guidePos).toBeLessThan(tipsPos);
    });

    it("returns no results for unmatched query", async () => {
      const result = await callTool("search", { query: "nonexistent" });
      expect(getText(result)).toBe("No results found.");
    });
  });

  describe("list", () => {
    beforeEach(async () => {
      await callTool("save", {
        title: "Note A",
        content: "First",
        folder: "public/tech",
        force: true,
      });
      await callTool("save", {
        title: "Note B",
        content: "Second",
        folder: "private/personal",
        force: true,
      });
    });

    it("lists all notes", async () => {
      const result = await callTool("list", {});
      const text = getText(result);
      expect(text).toContain("Note A");
      expect(text).toContain("Note B");
    });

    it("filters by folder", async () => {
      const result = await callTool("list", { folder: "public" });
      const text = getText(result);
      expect(text).toContain("Note A");
      expect(text).not.toContain("Note B");
    });

    it("returns empty for non-existent folder", async () => {
      const result = await callTool("list", { folder: "nope" });
      expect(getText(result)).toBe("No notes found.");
    });
  });

  describe("update", () => {
    beforeEach(async () => {
      await callTool("save", {
        title: "Updatable",
        content: "Original content",
        folder: "public/tech",
        force: true,
      });
    });

    it("replaces content and bumps updated date", async () => {
      const result = await callTool("update", {
        path: "public/tech/updatable.md",
        content: "New content",
      });
      expect(getText(result)).toContain("Updated:");

      const raw = await readFile(
        join(vaultPath, "public/tech/updatable.md"),
        "utf-8"
      );
      const parsed = matter(raw);
      expect(parsed.content.trim()).toBe("New content");
      expect(parsed.data["title"]).toBe("Updatable");
      expect(parsed.data["updated"]).toBeDefined();
    });

    it("returns error for missing file", async () => {
      const result = await callTool("update", {
        path: "nope.md",
        content: "x",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("delete", () => {
    it("deletes an existing note", async () => {
      await callTool("save", {
        title: "To Delete",
        content: "Gone soon",
        folder: "public/tech",
        force: true,
      });
      const result = await callTool("delete", {
        path: "public/tech/to-delete.md",
      });
      expect(getText(result)).toContain("Deleted:");

      await expect(
        readFile(join(vaultPath, "public/tech/to-delete.md"), "utf-8")
      ).rejects.toThrow();
    });

    it("returns error for missing file", async () => {
      const result = await callTool("delete", { path: "nope.md" });
      expect(result.isError).toBe(true);
    });
  });

  describe("create_folder", () => {
    it("creates a folder with parents and reports created:true", async () => {
      const result = await callTool("create_folder", {
        path: "a/b/c",
      });
      expect(getText(result)).toContain("Created folder: a/b/c");
      expect(result.structuredContent).toEqual({
        created: true,
        path: "a/b/c",
      });

      const stats = await stat(join(vaultPath, "a/b/c"));
      expect(stats.isDirectory()).toBe(true);
    });

    it("is idempotent and reports created:false on the second call", async () => {
      const first = await callTool("create_folder", { path: "x" });
      expect(first.structuredContent).toEqual({ created: true, path: "x" });

      const second = await callTool("create_folder", { path: "x" });
      expect(getText(second)).toContain("Already exists: x");
      expect(second.structuredContent).toEqual({ created: false, path: "x" });
      expect(second.isError).toBeFalsy();
    });

    it("errors when target path collides with an existing file", async () => {
      await writeFile(join(vaultPath, "afile.md"), "hi", "utf-8");
      const result = await callTool("create_folder", { path: "afile.md" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("exists and is a file");
    });

    it("rejects absolute paths", async () => {
      const result = await callTool("create_folder", { path: "/etc/foo" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toMatch(/absolute/);
    });

    it("rejects paths that escape vault root", async () => {
      const result = await callTool("create_folder", { path: "../escape" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Path traversal");
    });

    it("normalizes paths with redundant segments", async () => {
      const result = await callTool("create_folder", {
        path: "./a/./b/../c",
      });
      expect(result.structuredContent).toEqual({
        created: true,
        path: "a/c",
      });
      const stats = await stat(join(vaultPath, "a/c"));
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe("delete_folder", () => {
    it("deletes an empty folder", async () => {
      await mkdir(join(vaultPath, "empty"), { recursive: true });
      const result = await callTool("delete_folder", { path: "empty" });
      expect(getText(result)).toContain("Deleted folder:");
      await expect(stat(join(vaultPath, "empty"))).rejects.toThrow();
    });

    it("refuses to delete non-empty folder without force", async () => {
      await mkdir(join(vaultPath, "full"), { recursive: true });
      await writeFile(join(vaultPath, "full/note.md"), "hi", "utf-8");
      const result = await callTool("delete_folder", { path: "full" });
      expect(getText(result)).toContain("not empty");

      const stats = await stat(join(vaultPath, "full"));
      expect(stats.isDirectory()).toBe(true);
    });

    it("deletes non-empty folder with force", async () => {
      await mkdir(join(vaultPath, "full"), { recursive: true });
      await writeFile(join(vaultPath, "full/note.md"), "hi", "utf-8");
      const result = await callTool("delete_folder", {
        path: "full",
        force: true,
      });
      expect(getText(result)).toContain("Deleted folder:");
      await expect(stat(join(vaultPath, "full"))).rejects.toThrow();
    });

    it("returns error for missing folder", async () => {
      const result = await callTool("delete_folder", { path: "nope" });
      expect(result.isError).toBe(true);
    });

    it("returns error when path is a file", async () => {
      await writeFile(join(vaultPath, "file.txt"), "hi", "utf-8");
      const result = await callTool("delete_folder", { path: "file.txt" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("is not a folder");
    });
  });

  describe("list_folders", () => {
    beforeEach(async () => {
      await mkdir(join(vaultPath, "public/tech"), { recursive: true });
      await mkdir(join(vaultPath, "private"), { recursive: true });
      await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
    });

    it("lists root folders excluding .obsidian", async () => {
      const result = await callTool("list_folders", {});
      const text = getText(result);
      expect(text).toContain("public");
      expect(text).toContain("private");
      expect(text).not.toContain(".obsidian");
    });

    it("lists subfolders under a parent", async () => {
      const result = await callTool("list_folders", { path: "public" });
      const text = getText(result);
      expect(text).toContain("public/tech");
    });

    it("returns empty for folder with no subfolders", async () => {
      const result = await callTool("list_folders", { path: "private" });
      expect(getText(result)).toBe("No subfolders found.");
    });

    it("returns error for missing folder", async () => {
      const result = await callTool("list_folders", { path: "nope" });
      expect(result.isError).toBe(true);
    });
  });
});
