import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { resolveVaultPath, getAllMarkdownFiles } from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { toKebabCase, todayISO, inferFolder, extractBestSnippet } from "../text.js";

const CYRILLIC_RE = /[Ѐ-ӿ]/;

export function registerSave(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "save",
    {
      description:
        "Create a new note in an Obsidian vault. Searches for duplicates first — returns matches instead of creating if similar notes exist. Use force=true to skip duplicate check. Rejects titles containing Cyrillic characters.",
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
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({ title, content, folder, tags, force, vault }) => {
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

      if (CYRILLIC_RE.test(title)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: title contains Cyrillic characters. Use Latin transliteration instead.`,
            },
          ],
          isError: true,
        };
      }

      if (!force) {
        const files = await getAllMarkdownFiles(vaultPath);
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
            const fullPath = resolveVaultPath(vaultPath, filePath);
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
      const fullPath = resolveVaultPath(vaultPath, relativePath);

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

      const vaultName = vault ?? registry.defaultName;
      return {
        content: [{ type: "text" as const, text: `Created: [${vaultName}] ${relativePath}` }],
        structuredContent: { path: relativePath, vault: vaultName },
      };
    }
  );
}
