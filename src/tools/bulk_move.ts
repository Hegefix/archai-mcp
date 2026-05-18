import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import { readFile, writeFile, unlink, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  resolveVaultPath,
  getAllMarkdownFiles,
  normalizeVaultPath,
  vaultBasename,
} from "../paths.js";
import { rewriteWikilinks } from "../wikilinks.js";
import {
  recomputeMovedFileLinks,
  rewriteMarkdownLinksByPathMap,
  bumpUpdated,
} from "../refactor.js";
import { createGit, type GitClient } from "../git.js";

interface NormalizedOp {
  from: string;
  to: string;
  noOp: boolean;
}

interface OpResult {
  from: string;
  to: string;
  moved: boolean;
  link_updates_count: number;
}

interface BulkError {
  operation: { from: string; to: string } | null;
  message: string;
}

const NON_REPO_MSG = (vault: string) =>
  `Vault at ${vault} is not a git repository. Run 'git init' there, or pass unsafe_no_snapshot: true.`;

type Resp = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function errText(msg: string): Resp {
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

export function registerBulkMove(
  server: McpServer,
  vaultPath: string,
  gitClient?: GitClient
): void {
  const git = gitClient ?? createGit(vaultPath);

  server.registerTool(
    "bulk_move",
    {
      description:
        "Atomic batch of note moves with wikilink and markdown-link rewriting across the vault. Either all succeed or all roll back via `git reset --hard` to a snapshot commit taken before the operation. " +
        "By default takes a snapshot before starting; to skip the snapshot you MUST explicitly pass unsafe_no_snapshot=true — passing snapshot=false alone is rejected. " +
        "Topologically orders chains like A→B + B→C so the destination is free when each move runs; cycles (A→B + B→A) are rejected pre-flight. " +
        "Detects basename ambiguity against the projected post-move state of the vault. " +
        "After all file moves, runs ONE consolidated pass to rewrite incoming links across remaining notes. " +
        "Returns snapshot_sha (when a commit was actually taken — clean trees produce no commit) so the user can decide whether to keep, amend, or squash it; this tool does NOT auto-commit the resulting state.",
      inputSchema: {
        operations: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
            })
          )
          .describe("List of moves to apply atomically"),
        update_links: z
          .boolean()
          .optional()
          .describe("Rewrite incoming links across the vault. Default true."),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Plan only — return the full set of moves and expected link updates without writing. Default false."
          ),
        snapshot: z
          .boolean()
          .optional()
          .describe(
            "Take a git snapshot commit before starting. Default true. Setting false requires unsafe_no_snapshot=true."
          ),
        unsafe_no_snapshot: z
          .boolean()
          .optional()
          .describe(
            "Explicitly opt out of the snapshot/rollback safety net. Rollback becomes best-effort: on error the tool aborts and leaves partial state. Default false."
          ),
        snapshot_message: z
          .string()
          .optional()
          .describe('Commit message for the snapshot. Default "archai: pre-refactor snapshot".'),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            "Permit writing over a `to` that already exists (and is not another op's `from`). Default false."
          ),
        allow_ambiguity: z
          .boolean()
          .optional()
          .describe(
            "Permit proceeding when a destination basename collides with an existing distinct file. Default false."
          ),
      },
      annotations: { destructiveHint: true },
    },
    async ({
      operations,
      update_links = true,
      dry_run = false,
      snapshot = true,
      unsafe_no_snapshot = false,
      snapshot_message = "archai: pre-refactor snapshot",
      overwrite = false,
      allow_ambiguity = false,
    }) => {
      if (!snapshot && !unsafe_no_snapshot) {
        return errText(
          "snapshot:false requires unsafe_no_snapshot:true. The default snapshot path is recommended; opt out only when you understand the rollback risk."
        );
      }
      const useSnapshot = !unsafe_no_snapshot && snapshot;

      // Normalize operations
      const normalized: NormalizedOp[] = [];
      try {
        for (const op of operations) {
          const from = normalizeVaultPath(op.from);
          const to = normalizeVaultPath(op.to);
          if (!from.endsWith(".md"))
            return errText(`from must end in .md: ${op.from}`);
          if (!to.endsWith(".md"))
            return errText(`to must end in .md: ${op.to}`);
          normalized.push({ from, to, noOp: from === to });
        }
      } catch (err) {
        return errText(err instanceof Error ? err.message : String(err));
      }

      const realOps = normalized.filter((op) => !op.noOp);

      // Duplicate `to` within batch
      const toCounts = new Map<string, number>();
      for (const op of realOps) {
        toCounts.set(op.to, (toCounts.get(op.to) ?? 0) + 1);
      }
      const dupTos = [...toCounts.entries()]
        .filter(([, c]) => c > 1)
        .map(([p]) => p);
      if (dupTos.length > 0) {
        return errText(`Duplicate destination(s): ${dupTos.join(", ")}`);
      }

      // Duplicate `from` within batch
      const fromCounts = new Map<string, number>();
      for (const op of realOps) {
        fromCounts.set(op.from, (fromCounts.get(op.from) ?? 0) + 1);
      }
      const dupFroms = [...fromCounts.entries()]
        .filter(([, c]) => c > 1)
        .map(([p]) => p);
      if (dupFroms.length > 0) {
        return errText(`Duplicate source(s): ${dupFroms.join(", ")}`);
      }

      const fromSet = new Set(realOps.map((op) => op.from));

      // from exists & to-collision check
      for (const op of realOps) {
        const fromFull = resolveVaultPath(vaultPath, op.from);
        try {
          await stat(fromFull);
        } catch {
          return errText(`from not found: ${op.from}`);
        }
        const toFull = resolveVaultPath(vaultPath, op.to);
        let toExists = false;
        try {
          await stat(toFull);
          toExists = true;
        } catch {}
        if (toExists && !overwrite && !fromSet.has(op.to)) {
          return errText(
            `to already exists outside the batch: ${op.to}. Pass overwrite:true to replace, or include it in another op's from.`
          );
        }
      }

      // Topo sort
      let order: NormalizedOp[];
      try {
        order = topoSort(realOps);
      } catch (err) {
        return errText(err instanceof Error ? err.message : String(err));
      }

      // Ambiguity check against projected post-state
      const warnings: string[] = [];
      const allFiles = await getAllMarkdownFiles(vaultPath);
      const projectedFiles = new Set<string>(allFiles);
      for (const op of realOps) {
        projectedFiles.delete(op.from);
        projectedFiles.add(op.to);
      }
      for (const op of realOps) {
        const fromB = vaultBasename(op.from);
        const toB = vaultBasename(op.to);
        if (fromB === toB) continue;
        const conflicts = [...projectedFiles].filter(
          (f) => f !== op.to && vaultBasename(f) === toB
        );
        if (conflicts.length > 0) {
          if (!allow_ambiguity) {
            return errText(
              `Destination basename "${toB}" (${op.from} → ${op.to}) collides with: ${conflicts.join(", ")}. Pass allow_ambiguity:true to proceed.`
            );
          }
          warnings.push(
            `${op.to}: basename "${toB}" also used by ${conflicts.join(", ")}`
          );
        }
      }

      // Snapshot coverage check
      if (useSnapshot) {
        if (!(await git.isRepo())) {
          return errText(NON_REPO_MSG(vaultPath));
        }
        const ignored = await git.isIgnored(realOps.map((op) => op.from));
        if (ignored.length > 0) {
          return errText(
            `${ignored.join(", ")} is git-ignored; the snapshot would not capture it. Untrack the ignore or pass unsafe_no_snapshot:true.`
          );
        }
      }

      // Build maps
      const basenameMap = new Map<string, string>();
      const pathMap = new Map<string, string>();
      for (const op of realOps) {
        const fromB = vaultBasename(op.from);
        const toB = vaultBasename(op.to);
        if (fromB !== toB) basenameMap.set(fromB, toB);
        pathMap.set(op.from, op.to);
      }

      // Dry run
      if (dry_run) {
        const sim = await simulate(
          vaultPath,
          order,
          basenameMap,
          pathMap,
          update_links
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `[dry-run] Would move ${realOps.length} file(s) with ${sim.totalLinkUpdates} link update(s).`,
            },
          ],
          structuredContent: {
            success: true,
            results: sim.results,
            total_link_updates: sim.totalLinkUpdates,
            warnings,
            errors: [],
            rolled_back: false,
            dry_run: true,
          },
        };
      }

      // Real run
      let snapshot_sha: string | undefined;
      if (useSnapshot) {
        const snap = await git.snapshot(snapshot_message);
        if (snap.committed) snapshot_sha = snap.sha;
      }

      try {
        const result = await applyMoves(
          vaultPath,
          order,
          basenameMap,
          pathMap,
          update_links
        );
        const lines = [
          `Moved ${result.results.filter((r) => r.moved).length} file(s).`,
          `${result.totalLinkUpdates} link update(s).`,
        ];
        if (snapshot_sha)
          lines.push(`Snapshot: ${snapshot_sha.slice(0, 7)}`);
        if (warnings.length > 0)
          lines.push(`Warnings: ${warnings.join("; ")}`);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: {
            success: true,
            snapshot_sha,
            results: result.results,
            total_link_updates: result.totalLinkUpdates,
            warnings,
            errors: [],
            rolled_back: false,
            dry_run: false,
          },
        };
      } catch (err) {
        const errors: BulkError[] = [
          {
            operation: null,
            message: err instanceof Error ? err.message : String(err),
          },
        ];
        if (useSnapshot) {
          try {
            await git.resetHard();
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Bulk move failed and rolled back to snapshot.\nError: ${errors[0]!.message}`,
                },
              ],
              structuredContent: {
                success: false,
                snapshot_sha,
                results: [],
                total_link_updates: 0,
                warnings,
                errors,
                rolled_back: true,
                dry_run: false,
              },
              isError: true,
            };
          } catch (rbErr) {
            errors.push({
              operation: null,
              message: `Rollback also failed: ${
                rbErr instanceof Error ? rbErr.message : String(rbErr)
              }`,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Bulk move failed AND rollback failed. Vault may be in inconsistent state.\nErrors: ${errors
                    .map((e) => e.message)
                    .join("\n")}`,
                },
              ],
              structuredContent: {
                success: false,
                snapshot_sha,
                results: [],
                total_link_updates: 0,
                warnings,
                errors,
                rolled_back: false,
                dry_run: false,
              },
              isError: true,
            };
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Bulk move failed (unsafe_no_snapshot=true; no rollback).\nError: ${errors[0]!.message}`,
            },
          ],
          structuredContent: {
            success: false,
            results: [],
            total_link_updates: 0,
            warnings,
            errors,
            rolled_back: false,
            dry_run: false,
          },
          isError: true,
        };
      }
    }
  );
}

function topoSort(ops: NormalizedOp[]): NormalizedOp[] {
  const opByFrom = new Map<string, NormalizedOp>();
  for (const op of ops) opByFrom.set(op.from, op);

  const adj = new Map<NormalizedOp, NormalizedOp[]>();
  const inDeg = new Map<NormalizedOp, number>();
  for (const op of ops) {
    adj.set(op, []);
    inDeg.set(op, 0);
  }
  for (const X of ops) {
    const Y = opByFrom.get(X.to);
    if (Y && Y !== X) {
      adj.get(Y)!.push(X);
      inDeg.set(X, inDeg.get(X)! + 1);
    }
  }

  const queue: NormalizedOp[] = [];
  for (const [op, d] of inDeg) {
    if (d === 0) queue.push(op);
  }
  const order: NormalizedOp[] = [];
  while (queue.length > 0) {
    const op = queue.shift()!;
    order.push(op);
    for (const succ of adj.get(op)!) {
      const d = inDeg.get(succ)! - 1;
      inDeg.set(succ, d);
      if (d === 0) queue.push(succ);
    }
  }
  if (order.length !== ops.length) {
    throw new Error("Cycle detected in moves (e.g., A→B and B→A)");
  }
  return order;
}

function rewriteContentForMaps(
  content: string,
  notePath: string,
  basenameMap: Map<string, string>,
  pathMap: Map<string, string>,
  attribution: Map<string, number>,
  basenameToOpFrom: Map<string, string>
): { content: string; count: number } {
  let current = content;
  let count = 0;
  for (const [fromB, toB] of basenameMap) {
    const r = rewriteWikilinks(current, fromB, toB);
    if (r.updates.length > 0) {
      current = r.content;
      count += r.updates.length;
      const opFrom = basenameToOpFrom.get(fromB);
      if (opFrom) {
        attribution.set(
          opFrom,
          (attribution.get(opFrom) ?? 0) + r.updates.length
        );
      }
    }
  }
  const ml = rewriteMarkdownLinksByPathMap(
    current,
    notePath,
    pathMap,
    attribution
  );
  if (ml.updates.length > 0) {
    current = ml.content;
    count += ml.updates.length;
  }
  return { content: current, count };
}

async function applyMoves(
  vaultPath: string,
  order: NormalizedOp[],
  basenameMap: Map<string, string>,
  pathMap: Map<string, string>,
  updateLinks: boolean
): Promise<{ results: OpResult[]; totalLinkUpdates: number }> {
  const results: OpResult[] = order.map((op) => ({
    from: op.from,
    to: op.to,
    moved: false,
    link_updates_count: 0,
  }));
  let totalLinkUpdates = 0;
  const attribution = new Map<string, number>();
  for (const op of order) attribution.set(op.from, 0);
  const basenameToOpFrom = new Map<string, string>();
  for (const op of order) {
    const fromB = vaultBasename(op.from);
    if (basenameMap.has(fromB)) basenameToOpFrom.set(fromB, op.from);
  }

  // Phase 1: move each file
  for (let i = 0; i < order.length; i++) {
    const op = order[i]!;
    const fromFull = resolveVaultPath(vaultPath, op.from);
    const toFull = resolveVaultPath(vaultPath, op.to);
    let content = await readFile(fromFull, "utf-8");

    let totalForFile = 0;
    if (updateLinks) {
      // Wikilink rewrites — attribute by basename → original op
      for (const [fromB, toB] of basenameMap) {
        const r = rewriteWikilinks(content, fromB, toB);
        if (r.updates.length > 0) {
          content = r.content;
          totalForFile += r.updates.length;
          const opFrom = basenameToOpFrom.get(fromB);
          if (opFrom) {
            attribution.set(
              opFrom,
              (attribution.get(opFrom) ?? 0) + r.updates.length
            );
          }
        }
      }
      // Outgoing markdown links: recompute relative to new location, remap
      // any target that itself moved. mdHits records per-old-path counts for
      // markdown links pointing at moved targets; the remainder is "source
      // relocation only" recomputes and is attributed to the current op.
      const mdHits = new Map<string, number>();
      const ml = recomputeMovedFileLinks(
        content,
        op.from,
        op.to,
        pathMap,
        mdHits
      );
      content = ml.content;
      totalForFile += ml.updates.length;
      let mdMovedTotal = 0;
      for (const [oldPath, c] of mdHits) {
        attribution.set(oldPath, (attribution.get(oldPath) ?? 0) + c);
        mdMovedTotal += c;
      }
      const sourceReloc = ml.updates.length - mdMovedTotal;
      if (sourceReloc > 0) {
        attribution.set(
          op.from,
          (attribution.get(op.from) ?? 0) + sourceReloc
        );
      }
    }
    content = bumpUpdated(content);

    await mkdir(dirname(toFull), { recursive: true });
    await writeFile(toFull, content, "utf-8");
    if (fromFull !== toFull) {
      try {
        await unlink(fromFull);
      } catch {
        // already gone (e.g., overwrite case where to === from of next move)
      }
    }

    results[i]!.moved = true;
    totalLinkUpdates += totalForFile;
  }

  // Phase 2: rewrite incoming links in remaining files
  if (updateLinks) {
    const fromSet = new Set(order.map((op) => op.from));
    const toSet = new Set(order.map((op) => op.to));
    const files = await getAllMarkdownFiles(vaultPath);
    for (const file of files) {
      if (toSet.has(file) || fromSet.has(file)) continue;
      const full = resolveVaultPath(vaultPath, file);
      const original = await readFile(full, "utf-8");
      const { content: rewritten, count } = rewriteContentForMaps(
        original,
        file,
        basenameMap,
        pathMap,
        attribution,
        basenameToOpFrom
      );
      if (rewritten !== original) {
        await writeFile(full, rewritten, "utf-8");
        totalLinkUpdates += count;
      }
    }
  }

  // Fold per-op attribution into results.
  for (let i = 0; i < results.length; i++) {
    const op = order[i]!;
    results[i]!.link_updates_count = attribution.get(op.from) ?? 0;
  }

  return { results, totalLinkUpdates };
}

async function simulate(
  vaultPath: string,
  order: NormalizedOp[],
  basenameMap: Map<string, string>,
  pathMap: Map<string, string>,
  updateLinks: boolean
): Promise<{ results: OpResult[]; totalLinkUpdates: number }> {
  const results: OpResult[] = order.map((op) => ({
    from: op.from,
    to: op.to,
    moved: false,
    link_updates_count: 0,
  }));
  let totalLinkUpdates = 0;
  const attribution = new Map<string, number>();
  for (const op of order) attribution.set(op.from, 0);
  const basenameToOpFrom = new Map<string, string>();
  for (const op of order) {
    const fromB = vaultBasename(op.from);
    if (basenameMap.has(fromB)) basenameToOpFrom.set(fromB, op.from);
  }

  // Simulate phase 1
  for (let i = 0; i < order.length; i++) {
    const op = order[i]!;
    const fromFull = resolveVaultPath(vaultPath, op.from);
    let content = await readFile(fromFull, "utf-8");
    let totalForFile = 0;
    if (updateLinks) {
      for (const [fromB, toB] of basenameMap) {
        const r = rewriteWikilinks(content, fromB, toB);
        if (r.updates.length > 0) {
          content = r.content;
          totalForFile += r.updates.length;
          const opFrom = basenameToOpFrom.get(fromB);
          if (opFrom) {
            attribution.set(
              opFrom,
              (attribution.get(opFrom) ?? 0) + r.updates.length
            );
          }
        }
      }
      const mdHits = new Map<string, number>();
      const ml = recomputeMovedFileLinks(
        content,
        op.from,
        op.to,
        pathMap,
        mdHits
      );
      totalForFile += ml.updates.length;
      let mdMovedTotal = 0;
      for (const [oldPath, c] of mdHits) {
        attribution.set(oldPath, (attribution.get(oldPath) ?? 0) + c);
        mdMovedTotal += c;
      }
      const sourceReloc = ml.updates.length - mdMovedTotal;
      if (sourceReloc > 0) {
        attribution.set(
          op.from,
          (attribution.get(op.from) ?? 0) + sourceReloc
        );
      }
    }
    totalLinkUpdates += totalForFile;
  }

  // Simulate phase 2
  if (updateLinks) {
    const fromSet = new Set(order.map((op) => op.from));
    const files = await getAllMarkdownFiles(vaultPath);
    for (const file of files) {
      if (fromSet.has(file)) continue;
      const full = resolveVaultPath(vaultPath, file);
      const original = await readFile(full, "utf-8");
      const { count } = rewriteContentForMaps(
        original,
        file,
        basenameMap,
        pathMap,
        attribution,
        basenameToOpFrom
      );
      totalLinkUpdates += count;
    }
  }

  for (let i = 0; i < results.length; i++) {
    const op = order[i]!;
    results[i]!.link_updates_count = attribution.get(op.from) ?? 0;
  }

  return { results, totalLinkUpdates };
}
