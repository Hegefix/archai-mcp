/**
 * Classification of scanned wikilinks into health classes, plus the near-match
 * scoring that turns a dead link into an actionable rename suggestion.
 *
 * Pure module: it takes prebuilt vault indexes and a git rename map and returns
 * findings. Reading the filesystem and shelling out to git happen in the tools
 * (`lint_links`) and in `git.ts`, so every rule here is directly unit-testable.
 */

import type { Wikilink } from "./wikilinks.js";

/**
 * `ok`                — resolves to a note in this vault.
 * `planned`           — no target, but the line declares the gap deliberate.
 * `external`          — no target here, but the note exists in another vault.
 * `renamed-candidate` — no target, and one high-confidence replacement exists.
 * `broken`            — no target and nothing convincing to suggest.
 */
export type LinkClass = "ok" | "planned" | "external" | "renamed-candidate" | "broken";

/** Marker that declares a dangling link deliberate: a note the vault plans to write. */
export const PLANNED_MARKER = "<!-- intentional -->";

/** Minimum basename similarity before a dead link earns a rename suggestion. */
export const SUGGESTION_THRESHOLD = 0.75;

export type VaultIndex = {
  name: string;
  /** Vault-relative note paths, `.md` stripped, e.g. `concepts/react/react-query`. */
  paths: Set<string>;
  /** Basename to the paths carrying it, sorted. */
  byBasename: Map<string, string[]>;
};

/** Index a vault's markdown files (vault-relative posix paths, `.md` included). */
export function buildVaultIndex(name: string, files: string[]): VaultIndex {
  const paths = new Set<string>();
  const byBasename = new Map<string, string[]>();

  for (const file of files) {
    const stem = file.replace(/\.md$/i, "");
    paths.add(stem);
    const basename = stem.split("/").pop() as string;
    const existing = byBasename.get(basename);
    if (existing === undefined) byBasename.set(basename, [stem]);
    else existing.push(stem);
  }
  for (const list of byBasename.values()) list.sort();

  return { name, paths, byBasename };
}

/**
 * Resolve a link target the way Obsidian does: try the text as a vault-rooted
 * path first, then fall back to matching the basename anywhere in the vault. That
 * fallback is why `[[stack-state]]` reaches `work/mobile/stack-state.md` without a
 * folder prefix.
 *
 * When several notes share a basename Obsidian disambiguates by proximity; here
 * the lexicographically first path wins, which is stable but arbitrary.
 */
export function resolveTarget(index: VaultIndex, target: string): string | undefined {
  const clean = target.replace(/\.md$/i, "");
  if (index.paths.has(clean)) return clean;
  const hits = index.byBasename.get(clean.split("/").pop() as string);
  return hits?.[0];
}

function tokens(basename: string): string[] {
  return basename.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t !== "");
}

function levenshtein(a: string, a2: string): number {
  const b = a2;
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] as number) + 1;
      const deletion = (previous[j] as number) + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/**
 * How confidently one basename is a rename of another, in 0..1.
 *
 * Three signals, best one wins:
 *   - containment: every token of one name appears in the other. This is the
 *     shape a qualifying rename takes (`stack-state` to
 *     `goodhabitz-mobile-stack-state`), and plain overlap scores it far too low
 *     to survive the threshold, so it is scored explicitly. Guarded to multi-token
 *     or long single-token names so `react` doesn't claim `react-query`.
 *   - token overlap (Dice) for reorderings and partial edits.
 *   - character similarity for typos and suffix changes.
 */
export function basenameSimilarity(a: string, b: string): number {
  if (a === b) return 1;

  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const setA = new Set(ta);
  const setB = new Set(tb);
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;

  const smaller = setA.size <= setB.size ? setA : setB;
  const contained = shared === smaller.size;
  const substantial = smaller.size >= 2 || [...smaller].some((t) => t.length >= 8);
  const containment = contained && substantial ? 0.9 : 0;

  const dice = (2 * shared) / (setA.size + setB.size);
  const character = 1 - levenshtein(a, b) / Math.max(a.length, b.length);

  return Math.max(containment, dice, character);
}

export type Suggestion = {
  target: string;
  source: "git-rename" | "basename-similarity";
  score: number;
};

/**
 * Best replacement for a dead target, or undefined when nothing is convincing.
 *
 * Git history is trusted over similarity: a recorded rename is evidence, a
 * similar name is a guess. Similarity only wins with a unique best match — a tie
 * means the caller should look rather than let a bulk rewrite pick for them.
 */
export function suggestTarget(
  index: VaultIndex,
  target: string,
  renames: Map<string, string>
): { suggestion?: Suggestion; ambiguous?: string[] } {
  const basename = target.replace(/\.md$/i, "").split("/").pop() as string;

  const renamedTo = renames.get(basename);
  if (renamedTo !== undefined && renamedTo !== basename) {
    const resolved = resolveTarget(index, renamedTo);
    if (resolved !== undefined) {
      return { suggestion: { target: resolved, source: "git-rename", score: 1 } };
    }
  }

  let best: { target: string; score: number }[] = [];
  for (const [candidate, paths] of index.byBasename) {
    const score = basenameSimilarity(basename, candidate);
    if (score < SUGGESTION_THRESHOLD) continue;
    const first = paths[0] as string;
    if (best.length === 0 || score > (best[0] as { score: number }).score) {
      best = [{ target: first, score }];
    } else if (score === (best[0] as { score: number }).score) {
      best.push({ target: first, score });
    }
  }

  if (best.length === 0) return {};
  if (best.length > 1) return { ambiguous: best.map((b) => b.target).sort() };
  const winner = best[0] as { target: string; score: number };
  return {
    suggestion: { target: winner.target, source: "basename-similarity", score: winner.score },
  };
}

export type LinkFinding = {
  vault: string;
  /** Vault-relative path of the note containing the link, `.md` included. */
  file: string;
  line: number;
  raw: string;
  target: string;
  class: LinkClass;
  /** `ok`: the note the link resolves to. */
  resolved?: string;
  /** `renamed-candidate`: the target to rewrite to. */
  suggestion?: string;
  suggestionSource?: Suggestion["source"];
  /** `external`: the vault that does have this note. */
  externalVault?: string;
  /** `broken`: plausible targets that tied, so none was chosen. */
  ambiguous?: string[];
};

export type ClassifyContext = {
  index: VaultIndex;
  /** Every other configured vault, for `external` detection. */
  others: VaultIndex[];
  /** Old basename to current basename, from git rename history. */
  renames: Map<string, string>;
};

/**
 * Classify one link.
 *
 * Order matters. Resolution comes first, so a marked line that does resolve is
 * plain `ok`. `planned` then beats every failure class: it is an explicit
 * statement by the author that this gap is intended. `external` precedes the
 * suggestion machinery because a cross-vault link is unresolvable by design and
 * must never be "repaired" into pointing at a local note.
 */
export function classifyLink(
  link: Wikilink,
  file: string,
  ctx: ClassifyContext
): LinkFinding {
  const base: LinkFinding = {
    vault: ctx.index.name,
    file,
    line: link.line,
    raw: link.raw,
    target: link.target,
    class: "ok",
  };

  const resolved = resolveTarget(ctx.index, link.target);
  if (resolved !== undefined) return { ...base, resolved };

  if (link.lineText.includes(PLANNED_MARKER)) return { ...base, class: "planned" };

  for (const other of ctx.others) {
    if (resolveTarget(other, link.target) !== undefined) {
      return { ...base, class: "external", externalVault: other.name };
    }
  }

  const { suggestion, ambiguous } = suggestTarget(ctx.index, link.target, ctx.renames);
  if (suggestion !== undefined) {
    return {
      ...base,
      class: "renamed-candidate",
      suggestion: suggestion.target,
      suggestionSource: suggestion.source,
    };
  }
  return ambiguous === undefined
    ? { ...base, class: "broken" }
    : { ...base, class: "broken", ambiguous };
}

export const LINK_CLASSES: LinkClass[] = [
  "ok",
  "planned",
  "external",
  "renamed-candidate",
  "broken",
];

/** Per-class counts, every class present so a consumer can read a zero. */
export function summarize(findings: LinkFinding[]): Record<LinkClass, number> {
  const counts = Object.fromEntries(LINK_CLASSES.map((c) => [c, 0])) as Record<
    LinkClass,
    number
  >;
  for (const finding of findings) counts[finding.class]++;
  return counts;
}
