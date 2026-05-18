import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { mkdir } from "node:fs/promises";
import { resolveVaultPath } from "../paths.js";

export function registerCreateFolder(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "create_folder",
    {
      description:
        "Create a folder (and any parent folders) in the Obsidian vault.",
      inputSchema: {
        path: z
          .string()
          .describe(
            'Folder path relative to vault root, e.g. "public/tech/react"'
          ),
      },
    },
    async ({ path: folderPath }) => {
      const fullPath = resolveVaultPath(vaultPath, folderPath);
      await mkdir(fullPath, { recursive: true });
      return {
        content: [
          { type: "text" as const, text: `Created folder: ${folderPath}` },
        ],
      };
    }
  );
}
