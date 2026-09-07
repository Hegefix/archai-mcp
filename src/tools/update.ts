import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile, writeFile } from "node:fs/promises";
import { normalizeVaultPath, resolveVaultPath } from "../paths.js";
import { type VaultRegistry, resolveVault, isLogEnabled } from "../vaults.js";
import { todayISO } from "../text.js";
import { sourceSchema, mergeSources } from "../sources.js";
import { afterWrite } from "../hooks.js";
import { resolveStatusFields, STATUS_VALUES } from "../frontmatter.js";

export function registerUpdate(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "update",
    {
      description:
        "Update the content of an existing note. Preserves frontmatter (including " +
        "stale_when and any hand-added fields) and bumps the updated date. " +
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
        status: z
          // Deliberately a plain string, not z.enum: a schema-level rejection is an
          // opaque MCP validation error, and a stale client passing "seedling" needs
          // to be told what replaced it. resolveStatusFields does that.
          .string()
          .optional()
          .describe(
            `Change the note's status: ${STATUS_VALUES.join(" | ")}. Omit to keep the ` +
              'current one. "verified" requires a verified date; setting "draft" drops ' +
              "any stored one."
          ),
        verified: z
          .string()
          .optional()
          .describe(
            'Date (YYYY-MM-DD) the note was checked against its source. Legal only ' +
              'with status "verified", and required by it.'
          ),
        stale_when: z
          .string()
          .optional()
          .describe(
            "Replace the note's stale_when condition (free text). Omit to keep the " +
              "stored value; pass an empty string to remove it."
          ),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({
      path: notePath,
      content: newContent,
      sources,
      status,
      verified,
      stale_when,
      vault,
    }) => {
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

      const resolvedStatus = resolveStatusFields(
        {
          status: parsed.data["status"],
          verified: parsed.data["verified"],
        },
        {
          ...(status === undefined ? {} : { status }),
          ...(verified === undefined ? {} : { verified }),
        }
      );
      if (resolvedStatus.error !== undefined) {
        return {
          content: [{ type: "text" as const, text: `Error: ${resolvedStatus.error}` }],
          isError: true,
        };
      }

      parsed.data["updated"] = todayISO();
      parsed.data["status"] = resolvedStatus.status;
      if (resolvedStatus.verified === undefined) {
        delete parsed.data["verified"];
      } else {
        parsed.data["verified"] = resolvedStatus.verified;
      }
      if (stale_when !== undefined) {
        // An empty string is the explicit "remove it" signal; omitting the argument
        // leaves whatever the note already carries alone.
        if (stale_when.trim() === "") delete parsed.data["stale_when"];
        else parsed.data["stale_when"] = stale_when;
      }
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
        log: isLogEnabled(registry, vault ?? registry.defaultName),
      });

      const trailer =
        resolvedStatus.notes.length > 0 ? `\n${resolvedStatus.notes.join("\n")}` : "";
      return {
        content: [{ type: "text" as const, text: `Updated: ${notePath}${trailer}` }],
        structuredContent: {
          path: notePath,
          status: resolvedStatus.status,
          ...(resolvedStatus.verified === undefined
            ? {}
            : { verified: resolvedStatus.verified }),
          ...(resolvedStatus.notes.length > 0 ? { notes: resolvedStatus.notes } : {}),
        },
      };
    }
  );
}
