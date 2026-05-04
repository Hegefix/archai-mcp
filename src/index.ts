import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { glob } from "glob";
import { readFile, writeFile, unlink, mkdir, rm, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

export function toKebabCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function todayISO(): string {
  return new Date().toISOString().split("T")[0] as string;
}

export function resolveVaultPath(vaultPath: string, relativePath: string): string {
  const resolved = join(vaultPath, relativePath);
  if (!resolved.startsWith(vaultPath)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

function getAllMarkdownFiles(vaultPath: string): Promise<string[]> {
  return glob("**/*.md", {
    cwd: vaultPath,
    ignore: [".obsidian/**"],
    nodir: true,
  });
}

export function inferFolder(content: string): string {
  const personalKeywords =
    /\b(personal|career|life|journal|diary|health|finance|family|relationship|goal|habit)\b/i;
  return personalKeywords.test(content) ? "private/personal" : "public/tech";
}

export function findWordPositions(content: string, words: string[]): Map<string, number[]> {
  const lowerContent = content.toLowerCase();
  const positions = new Map<string, number[]>();
  for (const word of words) {
    const indices: number[] = [];
    let idx = 0;
    while ((idx = lowerContent.indexOf(word, idx)) !== -1) {
      indices.push(idx);
      idx += word.length;
    }
    positions.set(word, indices);
  }
  return positions;
}

export function extractBestSnippet(
  content: string,
  words: string[],
  windowSize = 150
): string {
  const positions = findWordPositions(content, words);
  const allPositions: number[] = [];
  for (const indices of positions.values()) {
    allPositions.push(...indices);
  }
  if (allPositions.length === 0) return "";
  allPositions.sort((a, b) => a - b);

  let bestStart = allPositions[0] ?? 0;
  let bestCount = 0;

  for (const anchor of allPositions) {
    const windowEnd = anchor + windowSize;
    let count = 0;
    for (const pos of allPositions) {
      if (pos >= anchor && pos <= windowEnd) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestStart = anchor;
    }
  }

  const start = Math.max(0, bestStart - 20);
  const end = Math.min(content.length, start + windowSize);
  let snippet = content.slice(start, end).replace(/\n/g, " ");
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet;
}

export function createServer(vaultPath: string): McpServer {
  const resolve = (rel: string) => resolveVaultPath(vaultPath, rel);
  const listFiles = () => getAllMarkdownFiles(vaultPath);

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
        const files = await listFiles();
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
            const fullPath = resolve(filePath);
            const fileContent = await readFile(fullPath, "utf-8");
            const lowerContent = fileContent.toLowerCase();
            contentMatch = titleWords.some((w) => lowerContent.includes(w));
            if (filenameMatch || contentMatch) {
              snippet = extractBestSnippet(fileContent, titleWords);
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
      const fullPath = resolve(relativePath);

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
      const fullPath = resolve(notePath);
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
      const files = await listFiles();
      const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No results found." }],
        };
      }

      const results: Array<{
        path: string;
        title: string;
        snippet: string;
        score: number;
      }> = [];

      for (const filePath of files) {
        const fullPath = resolve(filePath);
        const fileContent = await readFile(fullPath, "utf-8");
        const parsed = matter(fileContent);
        const noteTitle =
          (parsed.data["title"] as string | undefined) ??
          filePath.replace(/\.md$/, "");

        const fileNameLower = filePath.toLowerCase();
        const contentLower = fileContent.toLowerCase();

        const allWordsPresent = words.every(
          (w) => fileNameLower.includes(w) || contentLower.includes(w)
        );
        if (!allWordsPresent) continue;

        const filenameHits = words.filter((w) => fileNameLower.includes(w)).length;
        const contentPositions = findWordPositions(fileContent, words);
        let proximityScore = 0;
        if (filenameHits === 0) {
          const allPositions: number[] = [];
          for (const indices of contentPositions.values()) {
            allPositions.push(...indices);
          }
          allPositions.sort((a, b) => a - b);
          if (allPositions.length >= 2) {
            const span = (allPositions[allPositions.length - 1] as number) - (allPositions[0] as number);
            proximityScore = 1 / (1 + span);
          }
        }

        const score = filenameHits * 10 + proximityScore;
        const snippet = extractBestSnippet(fileContent, words);

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
      const files = await listFiles();
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
        const fullPath = resolve(filePath);
        const fileContent = await readFile(fullPath, "utf-8");
        const parsed = matter(fileContent);

        entries.push({
          path: filePath,
          title:
            (parsed.data["title"] as string | undefined) ??
            filePath.replace(/\.md$/, ""),
          status: String(parsed.data["status"] ?? "unknown"),
          created: parsed.data["created"] instanceof Date
            ? parsed.data["created"].toISOString().split("T")[0] as string
            : String(parsed.data["created"] ?? "unknown"),
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
      const fullPath = resolve(notePath);
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
      const fullPath = resolve(notePath);
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

  server.registerTool(
    "create_folder",
    {
      description:
        "Create a folder (and any parent folders) in the Obsidian vault.",
      inputSchema: {
        path: z
          .string()
          .describe(
            'Folder path relative to vault root, e.g. "public/tech/react"'
          ),
      },
    },
    async ({ path: folderPath }) => {
      const fullPath = resolve(folderPath);
      await mkdir(fullPath, { recursive: true });
      return {
        content: [
          { type: "text" as const, text: `Created folder: ${folderPath}` },
        ],
      };
    }
  );

  server.registerTool(
    "delete_folder",
    {
      description:
        "Delete a folder and all its contents from the Obsidian vault. Use force=true to delete non-empty folders.",
      inputSchema: {
        path: z
          .string()
          .describe("Folder path relative to vault root to delete"),
        force: z
          .boolean()
          .optional()
          .describe(
            "Delete even if folder is not empty. Defaults to false — will error on non-empty folders."
          ),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path: folderPath, force }) => {
      const fullPath = resolve(folderPath);

      let stats;
      try {
        stats = await stat(fullPath);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: folder not found at ${folderPath}`,
            },
          ],
          isError: true,
        };
      }

      if (!stats.isDirectory()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${folderPath} is not a folder`,
            },
          ],
          isError: true,
        };
      }

      if (!force) {
        const entries = await readdir(fullPath);
        if (entries.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Folder ${folderPath} is not empty (${entries.length} items). Call again with force=true to delete anyway.`,
              },
            ],
          };
        }
      }

      await rm(fullPath, { recursive: true });
      return {
        content: [
          { type: "text" as const, text: `Deleted folder: ${folderPath}` },
        ],
      };
    }
  );

  server.registerTool(
    "list_folders",
    {
      description:
        "List all folders in the Obsidian vault, optionally under a specific parent folder. Excludes .obsidian.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            'Parent folder to list under, e.g. "public". Omit for vault root.'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: parentPath }) => {
      const basePath = parentPath
        ? resolve(parentPath)
        : vaultPath;

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: folder not found at ${parentPath ?? "/"}`,
            },
          ],
          isError: true,
        };
      }

      const folders: string[] = [];
      for (const entry of entries) {
        if (entry === ".obsidian") continue;
        const entryPath = join(basePath, entry);
        const entryStats = await stat(entryPath);
        if (entryStats.isDirectory()) {
          folders.push(parentPath ? join(parentPath, entry) : entry);
        }
      }

      if (folders.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No subfolders found." },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: folders.map((f) => `- ${f}`).join("\n"),
          },
        ],
      };
    }
  );

  return server;
}

async function main(): Promise<void> {
  const vaultPath = process.env["ARCHAI_PATH"];
  if (!vaultPath) {
    console.error("ARCHAI_PATH environment variable is required");
    process.exit(1);
  }
  const server = createServer(vaultPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
