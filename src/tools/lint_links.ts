import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { listRenamedBasenames } from "../git.js";
import {
  classifyLink,
  summarize,
  LINK_CLASSES,
  PLANNED_MARKER,
  type LinkFinding,
  type VaultIndex,
} from "../lint-candidates.js";
import { buildIndex, loadNotes } from "../refactor.js";
import {
  INDEX_NOTE,
  findUnindexed,
  listIndexableFiles,
  readIndexCoverage,
} from "../index-coverage.js";

/** A `broken` or `renamed-candidate` link is a defect; the other classes are not. */
function isFailure(finding: LinkFinding): boolean {
  return finding.class === "broken" || finding.class === "renamed-candidate";
}

function describe(finding: LinkFinding): string {
  const where = `${finding.file}:${finding.line}`;
  switch (finding.class) {
    case "renamed-candidate":
      return `- ${where}  ${finding.raw} -> ${finding.suggestion} (${finding.suggestionSource})`;
    case "external":
      return `- ${where}  ${finding.raw} (exists in vault "${finding.externalVault}")`;
    case "broken":
      return finding.ambiguous === undefined
        ? `- ${where}  ${finding.raw}`
        : `- ${where}  ${finding.raw} (ambiguous: ${finding.ambiguous.join(", ")})`;
    default:
      return `- ${where}  ${finding.raw}`;
  }
}

export function registerLintLinks(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "lint_links",
    {
      description:
        "Classify every wikilink in one or all vaults as ok, planned, external, " +
        "renamed-candidate or broken, and return the suggested target for each " +
        `renamed-candidate so a repair can be fed straight into rewrite_links. A ` +
        `configured vault that is not present on this machine is reported as skipped, ` +
        `never as a clean vault. Links ` +
        `inside fenced or inline code are not links. A dangling link on a line carrying ` +
        `"${PLANNED_MARKER}" is reported as planned, not a failure; a link whose note ` +
        "lives in another vault is external, never broken. Also lists every note a vault's " +
        `root ${INDEX_NOTE} does not reach as unindexed (references count when the index ` +
        "names their path); an unindexed file makes the vault unhealthy, and a vault without " +
        `${INDEX_NOTE} is not checked. Read-only.`,
      inputSchema: {
        vault: z
          .string()
          .optional()
          .describe("Vault name. Omit to lint every configured vault."),
        classes: z
          .array(z.enum(["ok", "planned", "external", "renamed-candidate", "broken"]))
          .optional()
          .describe(
            "Restrict the listed findings to these classes. The summary always counts " +
              "everything. Defaults to every class except ok, which is usually noise."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ vault, classes }) => {
      let targets: Array<[string, string]>;
      try {
        targets =
          vault === undefined
            ? [...registry.vaults.entries()]
            : [[vault, resolveVault(registry, vault)]];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      // Every configured vault is indexed, not just the linted ones: `external`
      // classification is exactly the question "does another vault have this note".
      const indexes = new Map<string, VaultIndex>();
      for (const [name, path] of registry.vaults) {
        indexes.set(name, await buildIndex(name, path));
      }

      const findings: LinkFinding[] = [];
      const unindexed: Array<{ vault: string; file: string }> = [];
      for (const [name, vaultPath] of targets) {
        const index = indexes.get(name) as VaultIndex;

        const coverage = await readIndexCoverage(vaultPath, index);
        if (coverage !== null) {
          for (const file of findUnindexed(await listIndexableFiles(vaultPath), coverage)) {
            unindexed.push({ vault: name, file });
          }
        }

        const others = [...indexes.entries()]
          .filter(([other]) => other !== name)
          .map(([, i]) => i);
        const renames = await listRenamedBasenames(vaultPath);

        for (const note of await loadNotes(vaultPath)) {
          for (const link of note.links) {
            findings.push(classifyLink(link, note.file, { index, others, renames }));
          }
        }
      }

      // A vault that isn't on disk was never looked at, so it cannot be part of a
      // clean bill of health. Name it explicitly instead.
      const skipped = [...(registry.missing ?? new Map()).keys()].filter(
        (name) => vault === undefined || name === vault
      );

      const counts = summarize(findings);
      const shown = classes ?? LINK_CLASSES.filter((c) => c !== "ok");
      const failures = findings.filter(isFailure).length;

      const summaryLine =
        `${findings.length} link(s) across ${targets.length} vault(s): ` +
        LINK_CLASSES.map((c) => `${c}=${counts[c]}`).join(" ") +
        ` | failures=${failures}` +
        ` | unindexed=${unindexed.length}` +
        (skipped.length === 0 ? "" : ` | skipped=${skipped.join(",")}`);

      const sections = LINK_CLASSES.filter((c) => shown.includes(c))
        .map((cls) => {
          const group = findings.filter((f) => f.class === cls);
          if (group.length === 0) return "";
          const byVault = [...new Set(group.map((f) => f.vault))].map((v) => {
            const rows = group.filter((f) => f.vault === v).map(describe).join("\n");
            return `[${v}]\n${rows}`;
          });
          return `${cls} (${group.length})\n${byVault.join("\n")}`;
        })
        .filter((s) => s !== "");

      // Not a link class, so the `classes` filter doesn't apply: like a failure, an
      // unindexed file is always listed.
      if (unindexed.length > 0) {
        const byVault = [...new Set(unindexed.map((u) => u.vault))].map((v) => {
          const rows = unindexed
            .filter((u) => u.vault === v)
            .map((u) => `- ${u.file}`)
            .join("\n");
          return `[${v}]\n${rows}`;
        });
        sections.push(
          `unindexed (${unindexed.length}) — not reached from ${INDEX_NOTE}\n${byVault.join("\n")}`
        );
      }

      const text =
        sections.length === 0 ? summaryLine : `${summaryLine}\n\n${sections.join("\n\n")}`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          summary: {
            total: findings.length,
            vaults: targets.map(([name]) => name),
            ...counts,
            failures,
            unindexed: unindexed.length,
            healthy: failures === 0 && unindexed.length === 0,
            // `healthy` speaks only for the vaults that were read; `skipped` is what
            // it does not cover.
            skipped,
          },
          findings: findings.filter((f) => shown.includes(f.class)),
          unindexed,
        },
      };
    }
  );
}
