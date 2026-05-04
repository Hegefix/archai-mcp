import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { glob } from "glob";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

function getVaultPath(): string {
  const vaultPath = process.env["ARCHAI_PATH"];
  if (!vaultPath) {
    console.error("ARCHAI_PATH environment variable is required");
    process.exit(1);
  }
  return vaultPath;
}

const VAULT_PATH: string = getVaultPath();

function toKebabCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function todayISO(): string {
  return new Date().toISOString().split("T")[0] as string;
}

function resolveVaultPath(relativePath: string): string {
  const resolved = join(VAULT_PATH, relativePath);
  if (!resolved.startsWith(VAULT_PATH)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

async function getAllMarkdownFiles(): Promise<string[]> {
  return glob("**/*.md", {
    cwd: VAULT_PATH,
    ignore: [".obsidian/**"],
    nodir: true,
  });
}

function inferFolder(content: string): string {
  const personalKeywords =
    /\b(personal|career|life|journal|diary|health|finance|family|relationship|goal|habit)\b/i;
  return personalKeywords.test(content) ? "private/personal" : "public/tech";
}

function extractSnippet(
  content: string,
  query: string,
  contextChars = 100
): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerContent.indexOf(lowerQuery);
  if (idx === -1) return "";
  const start = Math.max(0, idx - contextChars / 2);
  const end = Math.min(content.length, idx + lowerQuery.length + contextChars / 2);
  let snippet = content.slice(start, end).replace(/\n/g, " ");
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet;
}

const server = new McpServer({
  name: "archai-mcp",
  version: "1.0.0",
});

server.registerTool(
  "save",
  {
    description:
      "Create a new note in the Obsidian vault. Searches for duplicates first — returns matches instead of creating if similar notes exist. Use force=true to skip duplicate check.",
    inputSchema: {
      title: z.string().describe("Note title"),
      content: z.string().describe("Markdown content of the note"),
      folder: z
        .string()
        .optional()
        .describe('Target folder relative to vault root, e.g. "public/tech"'),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags to add to frontmatter"),
      force: z
        .boolean()
        .optional()
        .describe("Skip duplicate check and create regardless"),
    },
  },
  async ({ title, content, folder, tags, force }) => {
    if (!force) {
      const files = await getAllMarkdownFiles();
      const titleWords = title
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const matches: Array<{ path: string; snippet: string }> = [];

      for (const filePath of files) {
        const fileName = filePath.toLowerCase();
        const filenameMatch = titleWords.some((w) => fileName.includes(w));

        let contentMatch = false;
        let snippet = "";
        if (filenameMatch || titleWords.length > 0) {
          const fullPath = resolveVaultPath(filePath);
          const fileContent = await readFile(fullPath, "utf-8");
          const lowerContent = fileContent.toLowerCase();
          contentMatch = titleWords.some((w) => lowerContent.includes(w));
          if (filenameMatch || contentMatch) {
            snippet = extractSnippet(fileContent, titleWords[0] ?? title);
          }
        }

        if (filenameMatch || contentMatch) {
          matches.push({ path: filePath, snippet });
        }

        if (matches.length >= 5) break;
      }

      if (matches.length > 0) {
        const matchList = matches
          .map((m) => `- ${m.path}\n  ${m.snippet}`)
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${matches.length} potentially similar note(s):\n\n${matchList}\n\nCall save again with force=true to create anyway.`,
            },
          ],
        };
      }
    }

    const targetFolder = folder ?? inferFolder(content);
    const filename = toKebabCase(title) + ".md";
    const relativePath = join(targetFolder, filename);
    const fullPath = resolveVaultPath(relativePath);

    const today = todayISO();
    const frontmatter: Record<string, unknown> = {
      title,
      created: today,
      updated: today,
      status: "seedling",
    };
    if (tags && tags.length > 0) {
      frontmatter["tags"] = tags;
    }

    const fileContent = matter.stringify(content, frontmatter);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, fileContent, "utf-8");

    return {
      content: [
        { type: "text" as const, text: `Created: ${relativePath}` },
      ],
    };
  }
);

server.registerTool(
  "read",
  {
    description: "Read the full content of a note from the Obsidian vault.",
    inputSchema: {
      path: z
        .string()
        .describe(
          'Relative path to the note, e.g. "public/tech/react-native-fabric.md"'
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ path: notePath }) => {
    const fullPath = resolveVaultPath(notePath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      return {
        content: [
          { type: "text" as const, text: `Error: file not found at ${notePath}` },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: content }],
    };
  }
);

server.registerTool(
  "search",
  {
    description:
      "Search all notes in the vault by filename and content. Returns top 10 matches with snippets.",
    inputSchema: {
      query: z.string().describe("Search query"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const files = await getAllMarkdownFiles();
    const lowerQuery = query.toLowerCase();

    const results: Array<{
      path: string;
      title: string;
      snippet: string;
      score: number;
    }> = [];

    for (const filePath of files) {
      const fullPath = resolveVaultPath(filePath);
      const fileContent = await readFile(fullPath, "utf-8");
      const parsed = matter(fileContent);
      const noteTitle =
        (parsed.data["title"] as string | undefined) ??
        filePath.replace(/\.md$/, "");

      const fileNameLower = filePath.toLowerCase();
      const contentLower = fileContent.toLowerCase();

      const filenameMatch = fileNameLower.includes(lowerQuery);
      const contentMatch = contentLower.includes(lowerQuery);

      if (!filenameMatch && !contentMatch) continue;

      const score = filenameMatch ? 2 : 1;
      const snippet = extractSnippet(fileContent, query);

      results.push({ path: filePath, title: noteTitle, snippet, score });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, 10);

    if (top.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No results found." },
        ],
      };
    }

    const formatted = top
      .map(
        (r) =>
          `**${r.title}**\nPath: ${r.path}\n${r.snippet ? `Snippet: ${r.snippet}` : ""}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

server.registerTool(
  "list",
  {
    description:
      "List all notes in the vault, optionally filtered by folder. Returns paths, titles, status, and creation dates sorted by date descending.",
    inputSchema: {
      folder: z
        .string()
        .optional()
        .describe(
          'Filter by folder prefix, e.g. "public/tech" or "private"'
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ folder }) => {
    const files = await getAllMarkdownFiles();
    const filtered = folder
      ? files.filter((f) => f.startsWith(folder))
      : files;

    const entries: Array<{
      path: string;
      title: string;
      status: string;
      created: string;
    }> = [];

    for (const filePath of filtered) {
      const fullPath = resolveVaultPath(filePath);
      const fileContent = await readFile(fullPath, "utf-8");
      const parsed = matter(fileContent);

      entries.push({
        path: filePath,
        title:
          (parsed.data["title"] as string | undefined) ??
          filePath.replace(/\.md$/, ""),
        status: (parsed.data["status"] as string | undefined) ?? "unknown",
        created: (parsed.data["created"] as string | undefined) ?? "unknown",
      });
    }

    entries.sort((a, b) => {
      if (a.created === "unknown") return 1;
      if (b.created === "unknown") return -1;
      return b.created.localeCompare(a.created);
    });

    if (entries.length === 0) {
      return {
        content: [
          { type: "text" as const, text: "No notes found." },
        ],
      };
    }

    const formatted = entries
      .map(
        (e) =>
          `- **${e.title}** (${e.status})\n  Path: ${e.path} | Created: ${e.created}`
      )
      .join("\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

server.registerTool(
  "update",
  {
    description:
      "Update the content of an existing note. Preserves frontmatter and bumps the updated date.",
    inputSchema: {
      path: z
        .string()
        .describe("Relative path to the note to update"),
      content: z
        .string()
        .describe(
          "New markdown content (replaces existing body, frontmatter is preserved)"
        ),
    },
  },
  async ({ path: notePath, content: newContent }) => {
    const fullPath = resolveVaultPath(notePath);
    let existing: string;
    try {
      existing = await readFile(fullPath, "utf-8");
    } catch {
      return {
        content: [
          { type: "text" as const, text: `Error: file not found at ${notePath}` },
        ],
        isError: true,
      };
    }

    const parsed = matter(existing);
    parsed.data["updated"] = todayISO();
    const updated = matter.stringify(
      newContent,
      parsed.data as Record<string, unknown>
    );

    await writeFile(fullPath, updated, "utf-8");

    return {
      content: [
        { type: "text" as const, text: `Updated: ${notePath}` },
      ],
    };
  }
);

server.registerTool(
  "delete",
  {
    description: "Delete a note from the Obsidian vault.",
    inputSchema: {
      path: z
        .string()
        .describe("Relative path to the note to delete"),
    },
    annotations: { destructiveHint: true },
  },
  async ({ path: notePath }) => {
    const fullPath = resolveVaultPath(notePath);
    try {
      await unlink(fullPath);
    } catch {
      return {
        content: [
          { type: "text" as const, text: `Error: file not found at ${notePath}` },
        ],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text" as const, text: `Deleted: ${notePath}` },
      ],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
