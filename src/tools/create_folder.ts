import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { mkdir, stat } from "node:fs/promises";
import { normalizeVaultPath, resolveVaultPath, assertKnownTopLevelFolder } from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { describeVaultLayouts, firstTopLevelFolder, type VaultFolderInfo } from "../text.js";

export function registerCreateFolder(
  server: McpServer,
  registry: VaultRegistry,
  vaultFolders: VaultFolderInfo[]
): void {
  const defaultVault = vaultFolders.find((v) => v.name === registry.defaultName);
  const layoutSummary = describeVaultLayouts(vaultFolders);
  const topFolder = firstTopLevelFolder(defaultVault);
  const pathExample = topFolder ? `${topFolder}/subfolder` : "new-folder";

  server.registerTool(
    "create_folder",
    {
      description:
        "Create a folder (and any parent folders) in an Obsidian vault. Idempotent: returns created=false when the folder already exists. Errors if the target path collides with a regular file. Rejects absolute paths and paths that escape vault root. The first path segment must match an existing top-level folder unless allowNewTopLevel is set.",
      inputSchema: {
        path: z
          .string()
          .describe(
            `Folder path relative to vault root, e.g. "${pathExample}". Known top-level folders — ${layoutSummary}.`
          ),
        allowNewTopLevel: z
          .boolean()
          .optional()
          .describe(
            "Allow creating a new top-level folder that doesn't exist yet in the vault. Without this, an unrecognized top-level folder is rejected."
          ),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({ path: folderPath, allowNewTopLevel, vault }) => {
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

      let normalized: string;
      try {
        normalized = normalizeVaultPath(folderPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      const fullPath = resolveVaultPath(vaultPath, normalized);

      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          return {
            content: [
              { type: "text" as const, text: `Already exists: ${normalized}` },
            ],
            structuredContent: { created: false, path: normalized },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${normalized} exists and is a file, not a folder`,
            },
          ],
          isError: true,
        };
      } catch {
        // Doesn't exist yet — validate the top-level segment, then fall through to create.
        if (!allowNewTopLevel) {
          try {
            await assertKnownTopLevelFolder(
              vaultPath,
              vault ?? registry.defaultName,
              normalized
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Error: ${msg}` }],
              isError: true,
            };
          }
        }
      }

      await mkdir(fullPath, { recursive: true });
      return {
        content: [
          { type: "text" as const, text: `Created folder: ${normalized}` },
        ],
        structuredContent: { created: true, path: normalized },
      };
    }
  );
}
