import { toKebabCase } from "./text.js";

export type CandidateReason =
  | "title_match"
  | "kebab_match"
  | "levenshtein"
  | "substring";

export interface Candidate {
  basename: string;
  path: string;
  similarity: number;
  reason: CandidateReason;
}

export type Classification =
  | "title_form"
  | "typo"
  | "phantom"
  | "attachment_missing";

export interface SuggestedFix {
  action: "rewrite_to" | "no_clear_match";
  target_basename?: string;
  confidence: "high" | "medium" | "low";
}

const DASH_RE = /[—–]/g;

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(DASH_RE, " ")
    .replace(/-/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function toKebabForMatch(s: string): string {
  return toKebabCase(s.replace(DASH_RE, " "));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

const SIMILARITY_FLOOR = 0.5;
const TOP_N = 3;

export function findCandidates(
  brokenTarget: string,
  basenameToPath: Map<string, string>
): Candidate[] {
  const targetNorm = normalizeForMatch(brokenTarget);
  const targetKebab = toKebabForMatch(brokenTarget);
  if (targetNorm.length === 0) return [];

  const candidates: Candidate[] = [];

  for (const [basename, path] of basenameToPath) {
    const basenameNorm = normalizeForMatch(basename);
    if (basenameNorm.length === 0) continue;

    if (basenameNorm === targetNorm) {
      candidates.push({
        basename,
        path,
        similarity: 1.0,
        reason: "title_match",
      });
      continue;
    }

    if (basename === targetKebab) {
      candidates.push({
        basename,
        path,
        similarity: 0.95,
        reason: "kebab_match",
      });
      continue;
    }

    const dist = levenshtein(targetKebab, basename);
    const levThreshold = Math.max(2, Math.floor(basename.length * 0.15));
    if (dist <= levThreshold) {
      const maxLen = Math.max(targetKebab.length, basename.length);
      const sim = maxLen === 0 ? 0 : 1 - dist / maxLen;
      if (sim >= SIMILARITY_FLOOR) {
        candidates.push({
          basename,
          path,
          similarity: sim,
          reason: "levenshtein",
        });
        continue;
      }
    }

    const [shorter, longer] =
      targetKebab.length <= basename.length
        ? [targetKebab, basename]
        : [basename, targetKebab];
    if (
      shorter.length > 0 &&
      longer.includes(shorter) &&
      shorter.length / longer.length >= 0.5
    ) {
      candidates.push({
        basename,
        path,
        similarity: shorter.length / longer.length,
        reason: "substring",
      });
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, TOP_N);
}

export function classifyBroken(candidates: Candidate[]): {
  classification: Classification;
  suggestedFix: SuggestedFix;
} {
  const top = candidates[0];
  if (!top) {
    return {
      classification: "phantom",
      suggestedFix: { action: "no_clear_match", confidence: "low" },
    };
  }

  if (top.reason === "title_match") {
    return {
      classification: "title_form",
      suggestedFix: {
        action: "rewrite_to",
        target_basename: top.basename,
        confidence: "high",
      },
    };
  }

  if (top.reason === "kebab_match" && top.similarity >= 0.9) {
    return {
      classification: "title_form",
      suggestedFix: {
        action: "rewrite_to",
        target_basename: top.basename,
        confidence: "high",
      },
    };
  }

  if (top.reason === "levenshtein" && top.similarity >= 0.85) {
    return {
      classification: "typo",
      suggestedFix: {
        action: "rewrite_to",
        target_basename: top.basename,
        confidence: "high",
      },
    };
  }

  if (top.reason === "levenshtein" && top.similarity >= 0.75) {
    return {
      classification: "typo",
      suggestedFix: {
        action: "rewrite_to",
        target_basename: top.basename,
        confidence: "medium",
      },
    };
  }

  return {
    classification: "phantom",
    suggestedFix: { action: "no_clear_match", confidence: "low" },
  };
}
