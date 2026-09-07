import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import {
  resolveVaultPath,
  getAllMarkdownFiles,
  readNoteOrNull,
} from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { findWordPositions, extractBestSnippet } from "../text.js";

type SearchHit = {
  vault: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
};

async function searchVault(
  vaultName: string,
  vaultPath: string,
  words: string[]
): Promise<SearchHit[]> {
  const files = await getAllMarkdownFiles(vaultPath);
  const hits: SearchHit[] = [];

  for (const filePath of files) {
    const fullPath = resolveVaultPath(vaultPath, filePath);
    const fileContent = await readNoteOrNull(fullPath);
    if (fileContent === null) continue;
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
        const span =
          (allPositions[allPositions.length - 1] as number) -
          (allPositions[0] as number);
        proximityScore = 1 / (1 + span);
      }
    }

    const score = filenameHits * 10 + proximityScore;
    const snippet = extractBestSnippet(fileContent, words);

    hits.push({ vault: vaultName, path: filePath, title: noteTitle, snippet, score });
  }

  return hits;
}

export function registerSearch(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "search",
    {
      description:
        "Search notes by filename and content. Searches all vaults unless a vault is given. Returns top 10 matches with snippets, labeled by vault.",
      inputSchema: {
        query: z.string().describe("Search query"),
        vault: z
          .string()
          .optional()
          .describe("Vault name to scope the search (defaults to all vaults)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, vault }) => {
      const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No results found." }],
        };
      }

      const targets: Array<[string, string]> = [];
      if (vault === undefined) {
        for (const [name, vaultPath] of registry.vaults) {
          targets.push([name, vaultPath]);
        }
      } else {
        let vaultPath: string;
        try {
          vaultPath = resolveVault(registry, vault);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${msg}` }],
            isError: true,
          };
        }
        targets.push([vault, vaultPath]);
      }

      const results: SearchHit[] = [];
      for (const [name, vaultPath] of targets) {
        results.push(...(await searchVault(name, vaultPath, words)));
      }

      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, 10);

      if (top.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No results found." }],
        };
      }

      const formatted = top
        .map(
          (r) =>
            `**${r.title}** [${r.vault}]\nPath: ${r.path}\n${r.snippet ? `Snippet: ${r.snippet}` : ""}`
        )
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
        structuredContent: {
          results: top.map((r) => ({
            vault: r.vault,
            path: r.path,
            title: r.title,
          })),
        },
      };
    }
  );
}
