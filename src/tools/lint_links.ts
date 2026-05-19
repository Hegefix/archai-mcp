import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { readFile } from "node:fs/promises";
import {
  resolveVaultPath,
  getAllMarkdownFiles,
  normalizeVaultPath,
  vaultBasename,
} from "../paths.js";
import { scanLinks, contextSnippet } from "../wikilinks.js";
import {
  findCandidates,
  classifyBroken,
  type Candidate,
  type Classification,
  type SuggestedFix,
} from "../lint-candidates.js";

interface Occurrence {
  path: string;
  line: number;
  column: number;
  raw: string;
  context: string;
}

interface BrokenLink {
  target: string;
  occurrences: Occurrence[];
  classification: Classification;
  candidates: Candidate[];
  suggested_fix: SuggestedFix;
}

const INTENTIONAL_RE = /^\s*<!--\s*intentional\s*-->/;

function isIntentional(content: string, after: number): boolean {
  const nl = content.indexOf("\n", after);
  const lineRest = content.slice(after, nl === -1 ? content.length : nl);
  return INTENTIONAL_RE.test(lineRest);
}

function normalizeScope(scope: string | undefined): string {
  if (!scope) return "";
  const norm = normalizeVaultPath(scope);
  if (norm === ".") return "";
  return norm.endsWith("/") ? norm : norm + "/";
}

export function registerLintLinks(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "lint_links",
    {
      description:
        "Audit all wikilinks across the vault. Returns every broken link (resolves to no file), classified by likely cause: title-form match to existing file, typo close-match, or phantom concept with no candidate. Each broken target carries candidate fixes (top 3 by similarity) and a suggested_fix with confidence. Read-only — does not modify files. Wikilinks immediately followed by `<!-- intentional -->` on the same line are skipped when ignore_intentional=true (default). Use this periodically to clean up the graph or after a bulk import; consume the structured output and apply fixes via rewrite_links.",
      inputSchema: {
        scope: z
          .string()
          .optional()
          .describe(
            "Optional folder prefix to limit scan, e.g. 'public/learning'. Default: whole vault."
          ),
        ignore_intentional: z
          .boolean()
          .optional()
          .describe(
            "Skip wikilinks marked as intentional placeholders via `<!-- intentional -->` on the same line. Default true."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scope, ignore_intentional = true }) => {
      let scopePrefix: string;
      try {
        scopePrefix = normalizeScope(scope);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }

      const allFiles = await getAllMarkdownFiles(vaultPath);
      const files = scopePrefix
        ? allFiles.filter((f) => f.startsWith(scopePrefix))
        : allFiles;

      const basenameToPath = new Map<string, string>();
      for (const f of files) {
        const b = vaultBasename(f);
        if (!basenameToPath.has(b)) basenameToPath.set(b, f);
      }

      let totalWikilinks = 0;
      const groups = new Map<string, Occurrence[]>();

      for (const file of files) {
        const full = resolveVaultPath(vaultPath, file);
        const content = await readFile(full, "utf-8");
        const refs = scanLinks(content);
        for (const ref of refs) {
          if (ref.kind !== "wikilink" && ref.kind !== "wikilink_embed") continue;
          if (!ref.basename) continue;
          totalWikilinks++;
          if (basenameToPath.has(ref.basename)) continue;
          if (
            ignore_intentional &&
            isIntentional(content, ref.offset + ref.length)
          ) {
            continue;
          }
          const occ: Occurrence = {
            path: file,
            line: ref.line,
            column: ref.column,
            raw: ref.raw,
            context: contextSnippet(content, ref.offset, ref.length),
          };
          const existing = groups.get(ref.basename);
          if (existing) existing.push(occ);
          else groups.set(ref.basename, [occ]);
        }
      }

      const broken_links: BrokenLink[] = [];
      const byClassification = { title_form: 0, typo: 0, phantom: 0 };
      let highConfidenceFixes = 0;
      let needsUserDecision = 0;

      for (const [target, occurrences] of groups) {
        const candidates = findCandidates(target, basenameToPath);
        const { classification, suggestedFix } = classifyBroken(candidates);
        byClassification[classification]++;
        if (suggestedFix.confidence === "high") highConfidenceFixes++;
        if (classification === "phantom" || suggestedFix.confidence === "low")
          needsUserDecision++;
        broken_links.push({
          target,
          occurrences,
          classification,
          candidates,
          suggested_fix: suggestedFix,
        });
      }

      broken_links.sort((a, b) => a.target.localeCompare(b.target));

      const broken_count = broken_links.length;
      const structured = {
        scanned_files: files.length,
        total_wikilinks: totalWikilinks,
        broken_count,
        broken_links,
        summary: {
          by_classification: byClassification,
          high_confidence_fixes: highConfidenceFixes,
          needs_user_decision: needsUserDecision,
        },
      };

      const parts = [
        `Scanned ${files.length} file${files.length === 1 ? "" : "s"}, ${totalWikilinks} wikilink${totalWikilinks === 1 ? "" : "s"}, found ${broken_count} broken`,
      ];
      if (broken_count > 0) {
        const segs: string[] = [];
        if (byClassification.title_form > 0)
          segs.push(
            `${byClassification.title_form} title_form (high-confidence rewrite)`
          );
        if (byClassification.typo > 0)
          segs.push(`${byClassification.typo} typo`);
        if (byClassification.phantom > 0)
          segs.push(`${byClassification.phantom} phantom (no candidate)`);
        parts.push(": " + segs.join(", "));
      }
      parts.push(".");

      return {
        content: [{ type: "text" as const, text: parts.join("") }],
        structuredContent: structured,
      };
    }
  );
}
