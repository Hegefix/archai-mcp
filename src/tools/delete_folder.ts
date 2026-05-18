import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { rm, readdir, stat } from "node:fs/promises";
import { resolveVaultPath } from "../paths.js";

export function registerDeleteFolder(server: McpServer, vaultPath: string): void {
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
      const fullPath = resolveVaultPath(vaultPath, folderPath);

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
}
