import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { unlink } from "node:fs/promises";
import { resolveVaultPath } from "../paths.js";

export function registerDelete(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "delete",
    {
      description: "Delete a note from the Obsidian vault.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the note to delete"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ path: notePath }) => {
      const fullPath = resolveVaultPath(vaultPath, notePath);
      try {
        await unlink(fullPath);
      } catch {
        return {
          content: [
            { type: "text" as const, text: `Error: file not found at ${notePath}` },
          ],
          isError: true,
        };
      }

      return {
        content: [
          { type: "text" as const, text: `Deleted: ${notePath}` },
        ],
      };
    }
  );
}
