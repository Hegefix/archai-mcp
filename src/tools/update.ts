import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile, writeFile } from "node:fs/promises";
import { resolveVaultPath } from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { todayISO } from "../text.js";

export function registerUpdate(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "update",
    {
      description:
        "Update the content of an existing note. Preserves frontmatter and bumps the updated date.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the note to update"),
        content: z
          .string()
          .describe(
            "New markdown content (replaces existing body, frontmatter is preserved)"
          ),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({ path: notePath, content: newContent, vault }) => {
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
      let existing: string;
      try {
        existing = await readFile(fullPath, "utf-8");
      } catch {
        return {
          content: [
            { type: "text" as const, text: `Error: file not found at ${notePath}` },
          ],
          isError: true,
        };
      }

      const parsed = matter(existing);
      parsed.data["updated"] = todayISO();
      const updated = matter.stringify(
        newContent,
        parsed.data as Record<string, unknown>
      );

      await writeFile(fullPath, updated, "utf-8");

      return {
        content: [{ type: "text" as const, text: `Updated: ${notePath}` }],
        structuredContent: { path: notePath },
      };
    }
  );
}
