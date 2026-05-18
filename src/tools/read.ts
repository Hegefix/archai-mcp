import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { readFile } from "node:fs/promises";
import { resolveVaultPath } from "../paths.js";

export function registerRead(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "read",
    {
      description: "Read the full content of a note from the Obsidian vault.",
      inputSchema: {
        path: z
          .string()
          .describe(
            'Relative path to the note, e.g. "public/tech/react-native-fabric.md"'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path: notePath }) => {
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
