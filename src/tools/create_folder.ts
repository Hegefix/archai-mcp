import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { mkdir, stat } from "node:fs/promises";
import { normalizeVaultPath, resolveVaultPath } from "../paths.js";

export function registerCreateFolder(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "create_folder",
    {
      description:
        "Create a folder (and any parent folders) in the Obsidian vault. Idempotent: returns created=false when the folder already exists. Errors if the target path collides with a regular file. Rejects absolute paths and paths that escape vault root.",
      inputSchema: {
        path: z
          .string()
          .describe(
            'Folder path relative to vault root, e.g. "public/tech/react"'
          ),
      },
    },
    async ({ path: folderPath }) => {
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
        // Doesn't exist — fall through to create.
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
