import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { resolveVaultPath, getAllMarkdownFiles } from "../paths.js";
import { findWordPositions, extractBestSnippet } from "../text.js";

export function registerSearch(server: McpServer, vaultPath: string): void {
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
      const files = await getAllMarkdownFiles(vaultPath);
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
        const fullPath = resolveVaultPath(vaultPath, filePath);
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
}
