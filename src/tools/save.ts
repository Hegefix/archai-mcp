import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname, posix } from "node:path";
import { resolveVaultPath, getAllMarkdownFiles, readNoteOrNull } from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { toKebabCase, todayISO, extractBestSnippet } from "../text.js";

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const MAX_REPORTED_MATCHES = 5;

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${text}` }],
    isError: true,
  };
}

async function exists(fullPath: string): Promise<boolean> {
  try {
    await access(fullPath);
    return true;
  } catch {
    return false;
  }
}

export function registerSave(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "save",
    {
      description:
        "Create a new note in an Obsidian vault. Refuses to overwrite an existing note and refuses a basename that already exists elsewhere in the vault, because [[wikilinks]] resolve by basename. Searches for similar notes first — returns matches instead of creating; use force=true to skip that check. Rejects titles containing Cyrillic characters.",
      inputSchema: {
        title: z.string().describe("Note title"),
        content: z.string().describe("Markdown content of the note"),
        folder: z
          .string()
          .optional()
          .describe(
            'Target folder relative to vault root, e.g. "tech/concepts/react". Omit to create at the vault root — the folder is never guessed.'
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags to add to frontmatter"),
        force: z
          .boolean()
          .optional()
          .describe("Skip the similarity check and create anyway. Does not permit overwriting."),
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
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      if (CYRILLIC_RE.test(title)) {
        return errorResult(
          "title contains Cyrillic characters. Use Latin transliteration instead."
        );
      }

      const slug = toKebabCase(title);
      if (slug === "") {
        return errorResult(
          `title "${title}" has no Latin letters or digits to build a filename from.`
        );
      }

      const filename = `${slug}.md`;
      const targetFolder = folder ?? "";
      const relativePath = targetFolder ? join(targetFolder, filename) : filename;

      let fullPath: string;
      try {
        fullPath = resolveVaultPath(vaultPath, relativePath);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }

      if (await exists(fullPath)) {
        return errorResult(
          `${relativePath} already exists. Use update to change it, or pick a different title.`
        );
      }

      const files = await getAllMarkdownFiles(vaultPath);

      // Links are kebab-basename, so two notes sharing a basename make every
      // [[link]] to either one ambiguous. Block it regardless of force.
      const basenameClash = files.find((f) => posix.basename(f) === filename);
      if (basenameClash !== undefined) {
        return errorResult(
          `a note named ${filename} already exists at ${basenameClash}. ` +
            `Basenames must be unique — [[${slug}]] would be ambiguous. Pick a different title.`
        );
      }

      if (!force) {
        const titleWords = title
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 2);

        const matches: Array<{ path: string; snippet: string }> = [];
        if (titleWords.length > 0) {
          for (const filePath of files) {
            const fileName = filePath.toLowerCase();
            // Every significant word must appear, in the filename or the body.
            // Matching on *any* word made a three-word title collide with most
            // of the vault and made save unusable without force.
            const fileContent = await readNoteOrNull(
              resolveVaultPath(vaultPath, filePath)
            );
            if (fileContent === null) continue;
            const lowerContent = fileContent.toLowerCase();

            const allPresent = titleWords.every(
              (w) => fileName.includes(w) || lowerContent.includes(w)
            );
            if (!allPresent) continue;

            matches.push({
              path: filePath,
              snippet: extractBestSnippet(fileContent, titleWords),
            });
          }
        }

        if (matches.length > 0) {
          const shown = matches.slice(0, MAX_REPORTED_MATCHES);
          const more =
            matches.length > shown.length
              ? `\n…and ${matches.length - shown.length} more.`
              : "";
          const matchList = shown
            .map((m) => `- ${m.path}\n  ${m.snippet}`)
            .join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${matches.length} note(s) containing every word of the title:\n\n${matchList}${more}\n\nCall save again with force=true to create anyway.`,
              },
            ],
          };
        }
      }

      const today = todayISO();
      const frontmatter: Record<string, unknown> = {
        title,
        created: today,
        updated: today,
        status: "draft",
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
