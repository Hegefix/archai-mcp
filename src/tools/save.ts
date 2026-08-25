import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  normalizeVaultPath,
  resolveVaultPath,
  getAllMarkdownFiles,
  assertKnownTopLevelFolder,
} from "../paths.js";
import { type VaultRegistry, resolveVault, isLogEnabled } from "../vaults.js";
import {
  toKebabCase,
  todayISO,
  extractBestSnippet,
  describeVaultLayouts,
  firstTopLevelFolder,
  type VaultFolderInfo,
} from "../text.js";
import { sourceSchema, mergeSources } from "../sources.js";
import { afterWrite } from "../hooks.js";
import { LOG_FILE } from "../log.js";
import {
  resolveStatusFields,
  STATUS_VALUES,
  DEFAULT_STATUS,
} from "../frontmatter.js";

const CYRILLIC_RE = /[Ѐ-ӿ]/;

export function registerSave(
  server: McpServer,
  registry: VaultRegistry,
  vaultFolders: VaultFolderInfo[]
): void {
  const defaultVault = vaultFolders.find((v) => v.name === registry.defaultName);
  const layoutSummary = describeVaultLayouts(vaultFolders);
  const folderExample = firstTopLevelFolder(defaultVault) ?? "(vault root — omit folder)";

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
          .describe(
            `Target folder relative to vault root, e.g. "${folderExample}". Omit to save at the vault root. Known top-level folders — ${layoutSummary}. The first path segment must match an existing top-level folder unless allowNewTopLevel is set.`
          ),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags to add to frontmatter"),
        sources: z
          .array(sourceSchema)
          .optional()
          .describe(
            "Provenance of the material this note was written from. Recorded in " +
              "frontmatter as `sources`; entries are deduped on resource + id."
          ),
        status: z
          // Deliberately a plain string, not z.enum: a schema-level rejection is an
          // opaque MCP validation error, and a stale client passing "seedling" needs
          // to be told what replaced it. resolveStatusFields does that.
          .string()
          .optional()
          .describe(
            `Note status: ${STATUS_VALUES.join(" | ")}. Defaults to ` +
              `"${DEFAULT_STATUS}". "verified" means checked against the source and ` +
              "REQUIRES a verified date. The retired seedling/growing/evergreen scale " +
              "is rejected with an error naming the replacement."
          ),
        verified: z
          .string()
          .optional()
          .describe(
            'Date (YYYY-MM-DD) the note was checked against its source. Legal only ' +
              'with status "verified", and required by it.'
          ),
        stale_when: z
          .string()
          .optional()
          .describe(
            "Free-text condition under which this note stops being true, e.g. " +
              '"prod moves past v1.63.0+2053". Event-based, not a date — that is how ' +
              "notes actually expire. Never checked automatically; read by a human."
          ),
        force: z
          .boolean()
          .optional()
          .describe("Skip duplicate check and create regardless"),
        allowNewTopLevel: z
          .boolean()
          .optional()
          .describe(
            "Allow creating the note under a top-level folder that doesn't exist yet in the vault. Without this, an unrecognized top-level folder is rejected."
          ),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({
      title,
      content,
      folder,
      tags,
      sources,
      status,
      verified,
      stale_when,
      force,
      allowNewTopLevel,
      vault,
    }) => {
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

      const resolvedStatus = resolveStatusFields(
        {},
        {
          ...(status === undefined ? {} : { status }),
          ...(verified === undefined ? {} : { verified }),
        }
      );
      if (resolvedStatus.error !== undefined) {
        return {
          content: [{ type: "text" as const, text: `Error: ${resolvedStatus.error}` }],
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
          // The activity log accumulates every note title ever written, so left in
          // the scan it eventually matches any new title and reports itself as a
          // near-duplicate of everything. It is never a note.
          if (filePath === LOG_FILE) continue;

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

      const targetFolder = folder ?? ".";
      const vaultName = vault ?? registry.defaultName;

      if (!allowNewTopLevel) {
        try {
          await assertKnownTopLevelFolder(vaultPath, vaultName, targetFolder);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error: ${msg}` }],
            isError: true,
          };
        }
      }

      const filename = toKebabCase(title) + ".md";
      const relativePath = join(targetFolder, filename);
      const fullPath = resolveVaultPath(vaultPath, relativePath);

      const today = todayISO();
      const frontmatter: Record<string, unknown> = {
        title,
        created: today,
        updated: today,
        status: resolvedStatus.status,
      };
      if (resolvedStatus.verified !== undefined) {
        frontmatter["verified"] = resolvedStatus.verified;
      }
      if (stale_when !== undefined && stale_when.trim() !== "") {
        frontmatter["stale_when"] = stale_when;
      }
      if (tags && tags.length > 0) {
        frontmatter["tags"] = tags;
      }
      if (sources && sources.length > 0) {
        frontmatter["sources"] = mergeSources([], sources);
      }

      const fileContent = matter.stringify(content, frontmatter);

      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, fileContent, "utf-8");

      await afterWrite({
        tool: "save",
        vaultName,
        vaultPath,
        // Normalized so the log line and commit message carry a posix path
        // regardless of the platform `join` above ran on.
        path: normalizeVaultPath(relativePath),
        title,
        log: isLogEnabled(registry, vaultName),
      });

      return {
        content: [
          { type: "text" as const, text: `Created: [${vaultName}] ${relativePath}` },
        ],
        structuredContent: {
          path: relativePath,
          vault: vaultName,
          status: resolvedStatus.status,
          ...(resolvedStatus.verified === undefined
            ? {}
            : { verified: resolvedStatus.verified }),
        },
      };
    }
  );
}
