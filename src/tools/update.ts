import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile, writeFile } from "node:fs/promises";
import { normalizeVaultPath, resolveVaultPath } from "../paths.js";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { todayISO } from "../text.js";
import { sourceSchema, mergeSources } from "../sources.js";
import { afterWrite } from "../hooks.js";

export function registerUpdate(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "update",
    {
      description:
        "Update the content of an existing note. Preserves frontmatter and bumps the updated date. " +
        "Any sources passed are merged into the note's existing provenance rather than replacing it.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the note to update"),
        content: z
          .string()
          .describe(
            "New markdown content (replaces existing body, frontmatter is preserved)"
          ),
        sources: z
          .array(sourceSchema)
          .optional()
          .describe(
            "Provenance to add to the note. Merged into the existing `sources` list, " +
              "deduped on resource + id — entries already recorded are kept, not replaced."
          ),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({ path: notePath, content: newContent, sources, vault }) => {
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
      if (sources && sources.length > 0) {
        // Provenance accumulates over a note's life, so merge instead of clobber.
        parsed.data["sources"] = mergeSources(parsed.data["sources"], sources);
      }
      const updated = matter.stringify(
        newContent,
        parsed.data as Record<string, unknown>
      );

      await writeFile(fullPath, updated, "utf-8");

      await afterWrite({
        tool: "update",
        vaultName: vault ?? registry.defaultName,
        vaultPath,
        path: normalizeVaultPath(notePath),
        title: parsed.data["title"] as string | undefined,
      });

      return {
        content: [{ type: "text" as const, text: `Updated: ${notePath}` }],
        structuredContent: { path: notePath },
      };
    }
  );
}
