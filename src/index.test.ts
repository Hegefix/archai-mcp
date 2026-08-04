import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import {
  createServer,
  toKebabCase,
  describeVaultLayouts,
  firstTopLevelFolder,
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

describe("describeVaultLayouts", () => {
  it("summarizes folders per vault", () => {
    expect(
      describeVaultLayouts([
        { name: "tech", topLevelFolders: ["concepts", "patterns", "projects"] },
        { name: "work", topLevelFolders: [] },
      ])
    ).toBe("tech: concepts, patterns, projects; work: flat, no subfolders");
  });
});

describe("firstTopLevelFolder", () => {
  it("returns the first folder when present", () => {
    expect(
      firstTopLevelFolder({ name: "tech", topLevelFolders: ["concepts", "patterns"] })
    ).toBe("concepts");
  });

  it("returns undefined for a flat vault or a missing vault", () => {
    expect(firstTopLevelFolder({ name: "work", topLevelFolders: [] })).toBeUndefined();
    expect(firstTopLevelFolder(undefined)).toBeUndefined();
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
    const server = await createServer(vaultPath);
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
        folder: "notes",
        allowNewTopLevel: true,
        force: true,
      });
      expect(getText(result)).toContain("Created: [default] notes/test-note.md");

      const filePath = join(vaultPath, "notes/test-note.md");
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
        folder: "notes",
        allowNewTopLevel: true,
        tags: ["ts", "mcp"],
        force: true,
      });
      const raw = await readFile(join(vaultPath, "notes/tagged-note.md"), "utf-8");
      const parsed = matter(raw);
      expect(parsed.data["tags"]).toEqual(["ts", "mcp"]);
    });

    it("defaults to the vault root when folder is omitted", async () => {
      const result = await callTool("save", {
        title: "Root Note",
        content: "x",
        force: true,
      });
      expect(getText(result)).toContain("Created: [default] root-note.md");
      const stats = await stat(join(vaultPath, "root-note.md"));
      expect(stats.isFile()).toBe(true);
    });

    it("rejects an unknown top-level folder without allowNewTopLevel", async () => {
      await callTool("create_folder", { path: "concepts", allowNewTopLevel: true });
      const result = await callTool("save", {
        title: "Misplaced Note",
        content: "x",
        folder: "public/tech",
        force: true,
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Unknown top-level folder "public"');
      expect(getText(result)).toContain("concepts");
    });

    it("allows nesting under an existing top-level folder without allowNewTopLevel", async () => {
      await callTool("create_folder", { path: "concepts", allowNewTopLevel: true });
      const result = await callTool("save", {
        title: "Nested Note",
        content: "x",
        folder: "concepts/react",
        force: true,
      });
      expect(result.isError).toBeFalsy();
      const stats = await stat(join(vaultPath, "concepts/react/nested-note.md"));
      expect(stats.isFile()).toBe(true);
    });

    it("rejects titles with Cyrillic characters", async () => {
      const result = await callTool("save", {
        title: "Заметка о React",
        content: "Some content",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Cyrillic");
    });

    it("warns about duplicates when force is not set", async () => {
      await callTool("save", {
        title: "Duplicate Test",
        content: "Original note",
        force: true,
      });
      const result = await callTool("save", {
        title: "Duplicate Test",
        content: "Another note",
      });
      expect(getText(result)).toContain("potentially similar");
    });
  });

  describe("read", () => {
    it("reads an existing note", async () => {
      await callTool("save", {
        title: "Read Me",
        content: "File content here",
        folder: "notes",
        allowNewTopLevel: true,
        force: true,
      });
      const result = await callTool("read", {
        path: "notes/read-me.md",
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
        folder: "notes",
        allowNewTopLevel: true,
        force: true,
      });
      await callTool("save", {
        title: "TypeScript Tips",
        content: "Advanced typescript patterns for react apps",
        folder: "notes",
        force: true,
      });
      await callTool("save", {
        title: "Cooking Pasta",
        content: "Boil water and add pasta",
        folder: "journal",
        allowNewTopLevel: true,
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
        folder: "notes",
        allowNewTopLevel: true,
        force: true,
      });
      await callTool("save", {
        title: "Note B",
        content: "Second",
        folder: "journal",
        allowNewTopLevel: true,
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
      const result = await callTool("list", { folder: "notes" });
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
        folder: "notes",
        allowNewTopLevel: true,
        force: true,
      });
    });

    it("replaces content and bumps updated date", async () => {
      const result = await callTool("update", {
        path: "notes/updatable.md",
        content: "New content",
      });
      expect(getText(result)).toContain("Updated:");

      const raw = await readFile(join(vaultPath, "notes/updatable.md"), "utf-8");
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

  describe("create_folder", () => {
    it("creates a folder with parents and reports created:true", async () => {
      const result = await callTool("create_folder", {
        path: "a/b/c",
        allowNewTopLevel: true,
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
      const first = await callTool("create_folder", {
        path: "x",
        allowNewTopLevel: true,
      });
      expect(first.structuredContent).toEqual({ created: true, path: "x" });

      const second = await callTool("create_folder", { path: "x" });
      expect(getText(second)).toContain("Already exists: x");
      expect(second.structuredContent).toEqual({ created: false, path: "x" });
      expect(second.isError).toBeFalsy();
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
        allowNewTopLevel: true,
      });
      expect(result.structuredContent).toEqual({
        created: true,
        path: "a/c",
      });
      const stats = await stat(join(vaultPath, "a/c"));
      expect(stats.isDirectory()).toBe(true);
    });

    it("rejects a new top-level folder without allowNewTopLevel, listing valid ones", async () => {
      await callTool("create_folder", { path: "concepts", allowNewTopLevel: true });
      const result = await callTool("create_folder", { path: "public" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain('Unknown top-level folder "public"');
      expect(getText(result)).toContain("concepts");
    });

    it("allows nesting under an existing top-level folder without allowNewTopLevel", async () => {
      await callTool("create_folder", { path: "concepts", allowNewTopLevel: true });
      const result = await callTool("create_folder", { path: "concepts/react" });
      expect(result.isError).toBeFalsy();
      const stats = await stat(join(vaultPath, "concepts/react"));
      expect(stats.isDirectory()).toBe(true);
    });

    it("reports a flat-vault message when no top-level folders exist yet", async () => {
      const result = await callTool("create_folder", { path: "concepts" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("no subfolders yet");
    });
  });
});

// --- Multi-vault integration tests ---

describe("multi-vault", () => {
  let personalPath: string;
  let workPath: string;
  let client: Client;

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: args });
  }

  beforeEach(async () => {
    personalPath = await mkdtemp(join(tmpdir(), "archai-personal-"));
    workPath = await mkdtemp(join(tmpdir(), "archai-work-"));
    const registry = {
      vaults: new Map([
        ["personal", personalPath],
        ["work", workPath],
      ]),
      defaultName: "personal",
    };
    const server = await createServer(registry);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await rm(personalPath, { recursive: true, force: true });
    await rm(workPath, { recursive: true, force: true });
  });

  it("list_vaults returns both names and marks the default", async () => {
    const result = await callTool("list_vaults", {});
    expect(result.structuredContent).toEqual({
      vaults: [
        { name: "personal", path: personalPath, default: true },
        { name: "work", path: workPath, default: false },
      ],
    });
  });

  it("save writes into the named non-default vault", async () => {
    await callTool("save", {
      title: "Work Note",
      content: "work content",
      vault: "work",
      force: true,
    });
    const raw = await readFile(join(workPath, "work-note.md"), "utf-8");
    expect(matter(raw).data["title"]).toBe("Work Note");
  });

  it("save defaults to the primary vault", async () => {
    const result = await callTool("save", {
      title: "Default Note",
      content: "x",
      force: true,
    });
    expect(getText(result)).toContain("[personal]");
    const stats = await stat(join(personalPath, "default-note.md"));
    expect(stats.isFile()).toBe(true);
  });

  it("read hits the correct vault", async () => {
    await callTool("save", {
      title: "Work Doc",
      content: "secret work content",
      vault: "work",
      force: true,
    });
    const result = await callTool("read", {
      path: "work-doc.md",
      vault: "work",
    });
    expect(getText(result)).toContain("secret work content");
  });

  it("returns an error for an unknown vault", async () => {
    const result = await callTool("read", {
      path: "whatever.md",
      vault: "nonexistent",
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("not found");
  });

  describe("with notes in both vaults", () => {
    beforeEach(async () => {
      await callTool("save", {
        title: "React Guide",
        content: "react native architecture",
        vault: "personal",
        force: true,
      });
      await callTool("save", {
        title: "React Sprint",
        content: "react work sprint planning",
        vault: "work",
        force: true,
      });
    });

    it("search spans all vaults by default, labeled", async () => {
      const result = await callTool("search", { query: "react" });
      const text = getText(result);
      expect(text).toContain("[personal]");
      expect(text).toContain("[work]");
    });

    it("search scopes to a single vault when given", async () => {
      const result = await callTool("search", { query: "react", vault: "work" });
      const text = getText(result);
      expect(text).toContain("[work]");
      expect(text).not.toContain("[personal]");
    });

    it("list spans all vaults by default, labeled", async () => {
      const result = await callTool("list", {});
      const text = getText(result);
      expect(text).toContain("[personal]");
      expect(text).toContain("[work]");
    });

    it("list scopes to a single vault when given", async () => {
      const result = await callTool("list", { vault: "personal" });
      const text = getText(result);
      expect(text).toContain("[personal]");
      expect(text).not.toContain("[work]");
    });
  });
});
