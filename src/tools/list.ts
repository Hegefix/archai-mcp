import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { resolveVaultPath, getAllMarkdownFiles } from "../paths.js";

export function registerList(server: McpServer, vaultPath: string): void {
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
      const files = await getAllMarkdownFiles(vaultPath);
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
        const fullPath = resolveVaultPath(vaultPath, filePath);
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
}
