import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveVaultPath } from "../paths.js";

export function registerListFolders(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "list_folders",
    {
      description:
        "List all folders in the Obsidian vault, optionally under a specific parent folder. Excludes .obsidian.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            'Parent folder to list under, e.g. "public". Omit for vault root.'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: parentPath }) => {
      const basePath = parentPath
        ? resolveVaultPath(vaultPath, parentPath)
        : vaultPath;

      let entries: string[];
      try {
        entries = await readdir(basePath);
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: folder not found at ${parentPath ?? "/"}`,
            },
          ],
          isError: true,
        };
      }

      const folders: string[] = [];
      for (const entry of entries) {
        if (entry === ".obsidian") continue;
        const entryPath = join(basePath, entry);
        const entryStats = await stat(entryPath);
        if (entryStats.isDirectory()) {
          folders.push(parentPath ? join(parentPath, entry) : entry);
        }
      }

      if (folders.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No subfolders found." },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: folders.map((f) => `- ${f}`).join("\n"),
          },
        ],
      };
    }
  );
}
