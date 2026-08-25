import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { describeVaultLayouts, firstTopLevelFolder, type VaultFolderInfo } from "../text.js";
import { buildIndex, findBacklinks, loadNotes, stem } from "../refactor.js";

export function registerFindBacklinks(
  server: McpServer,
  registry: VaultRegistry,
  vaultFolders: VaultFolderInfo[]
): void {
  const defaultVault = vaultFolders.find((v) => v.name === registry.defaultName);
  const layoutSummary = describeVaultLayouts(vaultFolders);
  const folder = firstTopLevelFolder(defaultVault);
  const pathExample = folder ? `${folder}/example-note.md` : "example-note.md";

  server.registerTool(
    "find_backlinks",
    {
      description:
        "List every note whose wikilinks point at a given note, with line numbers and " +
        "the link text as written. Matches by link resolution, so bare, folder-prefixed, " +
        "aliased and heading-anchored links to the same note are all found. Read-only.",
      inputSchema: {
        path: z
          .string()
          .describe(
            `Relative path of the note to find links to, e.g. "${pathExample}". ` +
              `A bare basename works too. Known top-level folders — ${layoutSummary}.`
          ),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: notePath, vault }) => {
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
      const vaultName = vault ?? registry.defaultName;

      let index, notes;
      try {
        index = await buildIndex(vaultName, vaultPath);
        notes = await loadNotes(vaultPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      // Accept a bare basename or a partial path by resolving it the same way a
      // link would be, so the caller doesn't have to know the note's full path.
      const requested = stem(notePath);
      const resolved = index.paths.has(requested)
        ? requested
        : index.byBasename.get(requested.split("/").pop() as string)?.[0];

      if (resolved === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: no note matching "${notePath}" in vault "${vaultName}"`,
            },
          ],
          isError: true,
        };
      }

      const backlinks = findBacklinks(notes, index, resolved);
      const files = new Set(backlinks.map((b) => b.file));

      const header =
        `${backlinks.length} link(s) to [${vaultName}] ${resolved}.md ` +
        `in ${files.size} note(s)`;
      const body = backlinks
        .map((b) => `- ${b.file}:${b.line}  ${b.raw}`)
        .join("\n");

      return {
        content: [
          { type: "text" as const, text: body === "" ? header : `${header}\n\n${body}` },
        ],
        structuredContent: {
          vault: vaultName,
          note: `${resolved}.md`,
          count: backlinks.length,
          files: files.size,
          backlinks,
        },
      };
    }
  );
}
