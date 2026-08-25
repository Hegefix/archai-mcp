import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { type VaultRegistry, resolveVault, isLogEnabled } from "../vaults.js";
import { afterWrite } from "../hooks.js";
import { createJournal } from "../rollback.js";
import {
  applyRewrites,
  buildIndex,
  describeRewrites,
  formatRewrites,
  loadNotes,
  normalizeMapping,
  planRewrites,
} from "../refactor.js";

export function registerRewriteLinks(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "rewrite_links",
    {
      description:
        "Rewrite wikilink targets across a vault from an explicit old->new mapping, " +
        "leaving the notes themselves where they are. Built to consume lint_links' " +
        "renamed-candidate suggestions. Alias and heading parts are preserved: " +
        "[[old|Label]] becomes [[new|Label]] and [[old#Section]] becomes [[new#Section]]. " +
        "Mapping keys match a link target's basename, so one key covers both [[old]] and " +
        "[[folder/old]]. Use dry_run to see the diff first.",
      inputSchema: {
        mapping: z
          .record(z.string())
          .describe(
            "Old target to new target, e.g. { \"old-note\": \"new-note\" }. Keys and " +
              "values may carry folders or a .md extension; only the key's basename is " +
              "matched, and the written form follows the vault's convention (bare " +
              "basename unless it is ambiguous)."
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe("Report the diff that would be applied and write nothing."),
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
    },
    async ({ mapping, dry_run, vault }) => {
      let vaultPath: string;
      let normalized;
      try {
        vaultPath = resolveVault(registry, vault);
        normalized = normalizeMapping(mapping);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
      const vaultName = vault ?? registry.defaultName;

      if (normalized.size === 0) {
        return {
          content: [{ type: "text" as const, text: "Error: mapping is empty" }],
          isError: true,
        };
      }

      const index = await buildIndex(vaultName, vaultPath);
      const notes = await loadNotes(vaultPath);
      const rewrites = planRewrites(notes, normalized, index);
      const summary = describeRewrites(rewrites);

      if (rewrites.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No links matched the mapping in vault "${vaultName}".`,
            },
          ],
          structuredContent: { vault: vaultName, dryRun: dry_run === true, rewrites: [] },
        };
      }

      const diff = formatRewrites(vaultName, rewrites);

      if (dry_run === true) {
        return {
          content: [
            { type: "text" as const, text: `Dry run — would rewrite ${summary}:\n\n${diff}` },
          ],
          structuredContent: {
            vault: vaultName,
            dryRun: true,
            rewrites: rewrites.map((r) => ({ file: r.file, changes: r.changes })),
          },
        };
      }

      // A part-applied rewrite leaves the graph in a state nobody asked for: some
      // notes pointing at the new name, some at the old. Undo and report instead.
      const journal = createJournal();
      try {
        await applyRewrites(vaultPath, rewrites, journal);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const restoreWarnings = await journal.rollback();
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: rewrite failed and was rolled back: ${detail}${
                restoreWarnings.length > 0 ? `\n${restoreWarnings.join("\n")}` : ""
              }`,
            },
          ],
          isError: true,
        };
      }

      const warnings = await afterWrite({
        tool: "rewrite_links",
        vaultName,
        vaultPath,
        path: `${rewrites.length} file(s)`,
        paths: rewrites.map((r) => r.file),
        log: isLogEnabled(registry, vaultName),
        message: `rewrite_links: ${summary}`,
      });

      const trailer = warnings.length > 0 ? `\n\n${warnings.join("\n")}` : "";
      return {
        content: [
          { type: "text" as const, text: `Rewrote ${summary}:\n\n${diff}${trailer}` },
        ],
        structuredContent: {
          vault: vaultName,
          dryRun: false,
          links: rewrites.reduce((sum, r) => sum + r.changes.length, 0),
          files: rewrites.length,
          rewrites: rewrites.map((r) => ({ file: r.file, changes: r.changes })),
        },
      };
    }
  );
}
