import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile, writeFile } from "node:fs/promises";
import { resolveVaultPath } from "../paths.js";
import { todayISO } from "../text.js";
import { normalizeWikilinks } from "../wikilink-normalize.js";

export function registerUpdate(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "update",
    {
      description:
        "Update the content of an existing note. Preserves frontmatter and bumps the updated date. Wikilinks in the body are normalized to kebab-case basenames before writing (e.g. [[Pretty Title]] → [[pretty-title]]); set normalize_wikilinks=false to preserve raw input verbatim (only needed when authoring docs that show anti-pattern examples).",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path to the note to update"),
        content: z
          .string()
          .describe(
            "New markdown content (replaces existing body, frontmatter is preserved)"
          ),
        normalize_wikilinks: z
          .boolean()
          .optional()
          .describe(
            "Normalize wikilinks in the body to kebab-case basenames. Default true. Set false to preserve raw input (e.g. docs showing anti-patterns)."
          ),
      },
    },
    async ({ path: notePath, content: newContent, normalize_wikilinks }) => {
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

      const shouldNormalize = normalize_wikilinks !== false;
      const { content: bodyContent, changes: normalizationChanges } =
        shouldNormalize
          ? normalizeWikilinks(newContent)
          : { content: newContent, changes: [] };

      const parsed = matter(existing);
      parsed.data["updated"] = todayISO();
      const updated = matter.stringify(
        bodyContent,
        parsed.data as Record<string, unknown>
      );

      await writeFile(fullPath, updated, "utf-8");

      const lines: string[] = [`Updated: ${notePath}`];
      if (normalizationChanges.length > 0) {
        lines.push(
          `Normalized ${normalizationChanges.length} wikilink${normalizationChanges.length === 1 ? "" : "s"}:`
        );
        for (const c of normalizationChanges) {
          lines.push(`  ${c.from} → ${c.to}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          path: notePath,
          normalized_wikilinks: normalizationChanges,
        },
      };
    }
  );
}
