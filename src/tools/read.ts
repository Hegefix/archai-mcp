import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { readFile } from "node:fs/promises";
import { resolveVaultPath } from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { describeVaultLayouts, firstTopLevelFolder, type VaultFolderInfo } from "../text.js";

export function registerRead(
  server: McpServer,
  registry: VaultRegistry,
  vaultFolders: VaultFolderInfo[]
): void {
  const defaultVault = vaultFolders.find((v) => v.name === registry.defaultName);
  const layoutSummary = describeVaultLayouts(vaultFolders);
  const folder = firstTopLevelFolder(defaultVault);
  const pathExample = folder ? `${folder}/example-note.md` : "example-note.md";

  server.registerTool(
    "read",
    {
      description: "Read the full content of a note from an Obsidian vault.",
      inputSchema: {
        path: z
          .string()
          .describe(
            `Relative path to the note, e.g. "${pathExample}". Known top-level folders — ${layoutSummary}.`
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
      const fullPath = resolveVaultPath(vaultPath, notePath);
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
}
