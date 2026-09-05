import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { type VaultRegistry, resolveVault } from "../vaults.js";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
  resolveVaultPath,
  getAllMarkdownFiles,
  getAllAttachmentFiles,
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

interface Group {
  occurrences: Occurrence[];
  isAttachment: boolean;
}

const INTENTIONAL_RE = /^\s*<!--\s*intentional\s*-->/;

const ATTACHMENT_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "mp4",
  "mov",
  "webm",
  "mp3",
  "wav",
  "ogg",
  "zip",
  "csv",
  "xlsx",
  "docx",
] as const;

const ATTACHMENT_EXT_SET = new Set<string>(
  ATTACHMENT_EXTENSIONS.map((e) => "." + e)
);

function getAttachmentExt(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot).toLowerCase();
  return ATTACHMENT_EXT_SET.has(ext) ? ext : null;
}

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

export function registerLintLinks(server: McpServer, registry: VaultRegistry): void {
  server.registerTool(
    "lint_links",
    {
      description:
        "Audit all wikilinks across the vault. Returns every broken link (resolves to no file), classified by likely cause: title-form match to existing file, typo close-match, or phantom concept with no candidate. Each broken target carries candidate fixes (top 3 by similarity) and a suggested_fix with confidence. Read-only — does not modify files. Wikilinks immediately followed by `<!-- intentional -->` on the same line are skipped when ignore_intentional=true (default). Use this periodically to clean up the graph or after a bulk import; consume the structured output and apply fixes via rewrite_links. Wikilinks with attachment extensions (.pdf, .png, .mp4, etc.) are resolved against the vault filesystem; missing attachments are classified as `attachment_missing`.",
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
        vault: z
          .string()
          .optional()
          .describe("Vault name (defaults to the primary vault)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ scope, ignore_intentional = true, vault }) => {
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

      // Basename resolution is always full-vault: wikilinks resolve by basename
      // regardless of folder. `scope` only narrows which files we scan for
      // occurrences, not which files can satisfy a link.
      const basenameToPath = new Map<string, string>();
      for (const f of allFiles) {
        const b = vaultBasename(f);
        if (!basenameToPath.has(b)) basenameToPath.set(b, f);
      }

      const attachmentFiles = await getAllAttachmentFiles(
        vaultPath,
        ATTACHMENT_EXTENSIONS
      );
      const attachmentByPath = new Set<string>(attachmentFiles);
      const attachmentByBasename = new Map<string, string[]>();
      for (const f of attachmentFiles) {
        const b = path.posix.basename(f);
        const list = attachmentByBasename.get(b);
        if (list) list.push(f);
        else attachmentByBasename.set(b, [f]);
      }

      let totalWikilinks = 0;
      const groups = new Map<string, Group>();

      for (const file of files) {
        const full = resolveVaultPath(vaultPath, file);
        const content = await readFile(full, "utf-8");
        const refs = scanLinks(content);
        for (const ref of refs) {
          if (ref.kind !== "wikilink" && ref.kind !== "wikilink_embed") continue;
          if (!ref.basename) continue;
          totalWikilinks++;

          const isAttachment = getAttachmentExt(ref.basename) !== null;
          let resolved: boolean;
          let groupKey: string;

          if (isAttachment) {
            const baseTarget =
              ref.target?.split("#")[0] ?? ref.basename;
            groupKey = baseTarget;
            const hasPath = baseTarget.includes("/");
            if (hasPath) {
              resolved =
                attachmentByPath.has(baseTarget) ||
                attachmentByBasename.has(ref.basename);
            } else {
              resolved = attachmentByBasename.has(ref.basename);
            }
          } else {
            groupKey = ref.basename;
            resolved = basenameToPath.has(ref.basename);
          }

          if (resolved) continue;
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
          const existing = groups.get(groupKey);
          if (existing) existing.occurrences.push(occ);
          else groups.set(groupKey, { occurrences: [occ], isAttachment });
        }
      }

      const broken_links: BrokenLink[] = [];
      const byClassification = {
        title_form: 0,
        typo: 0,
        phantom: 0,
        attachment_missing: 0,
      };
      let highConfidenceFixes = 0;
      let needsUserDecision = 0;

      for (const [target, group] of groups) {
        let classification: Classification;
        let candidates: Candidate[];
        let suggestedFix: SuggestedFix;
        if (group.isAttachment) {
          classification = "attachment_missing";
          candidates = [];
          suggestedFix = { action: "no_clear_match", confidence: "low" };
        } else {
          candidates = findCandidates(target, basenameToPath);
          const c = classifyBroken(candidates);
          classification = c.classification;
          suggestedFix = c.suggestedFix;
        }
        byClassification[classification]++;
        if (suggestedFix.confidence === "high") highConfidenceFixes++;
        if (
          classification === "phantom" ||
          classification === "attachment_missing" ||
          suggestedFix.confidence === "low"
        )
          needsUserDecision++;
        broken_links.push({
          target,
          occurrences: group.occurrences,
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
        if (byClassification.attachment_missing > 0)
          segs.push(
            `${byClassification.attachment_missing} attachment_missing`
          );
        parts.push(": " + segs.join(", "));
      }
      parts.push(".");

      let text = parts.join("");
      if (broken_count > 0) {
        const MAX = 10;
        const shown = broken_links.slice(0, MAX);
        const lines: string[] = ["", "Broken targets:"];
        for (const bl of shown) {
          const tag =
            bl.classification === "attachment_missing" ? " [attachment]" : "";
          lines.push(
            `- [[${bl.target}]]${tag} (${bl.classification})`
          );
          for (const occ of bl.occurrences) {
            lines.push(`    ${occ.path}:${occ.line}`);
          }
        }
        if (broken_count > MAX) {
          lines.push(
            `... and ${broken_count - MAX} more (see structuredContent)`
          );
        }
        text += "\n" + lines.join("\n");
      }

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: structured,
      };
    }
  );
}
