import { describe, it, expect } from "vitest";
import {
  normalizeForMatch,
  toKebabForMatch,
  levenshtein,
  findCandidates,
  classifyBroken,
} from "./lint-candidates.js";

function makeMap(basenames: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const b of basenames) m.set(b, `public/${b}.md`);
  return m;
}

describe("normalizeForMatch", () => {
  it("lowercases, replaces dashes and punctuation with space, collapses whitespace", () => {
    expect(normalizeForMatch("How the Internet Works — HTTP, HTML, Protocols")).toBe(
      "how the internet works http html protocols"
    );
  });

  it("treats hyphen as separator", () => {
    expect(normalizeForMatch("how-the-internet-works")).toBe(
      "how the internet works"
    );
  });

  it("strips punctuation", () => {
    expect(normalizeForMatch("FP vs. OOP: Trade-offs!")).toBe("fp vs oop trade offs");
  });

  it("returns empty for punctuation-only input", () => {
    expect(normalizeForMatch("---")).toBe("");
  });
});

describe("toKebabForMatch", () => {
  it("handles em-dash and en-dash as separators", () => {
    expect(toKebabForMatch("FP vs OOP — Trade-offs")).toBe("fp-vs-oop-trade-offs");
    expect(toKebabForMatch("Concept – Other")).toBe("concept-other");
  });

  it("matches existing kebab-case", () => {
    expect(toKebabForMatch("how the internet works")).toBe("how-the-internet-works");
  });
});

describe("levenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("returns length for empty other", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("counts single substitution", () => {
    expect(levenshtein("cat", "bat")).toBe(1);
  });

  it("counts insert", () => {
    expect(levenshtein("cat", "cats")).toBe(1);
  });
});

describe("findCandidates", () => {
  it("title_match: title-form variant scores 1.0", () => {
    const map = makeMap(["how-the-internet-works-http-html-protocols"]);
    const out = findCandidates(
      "How the Internet Works — HTTP, HTML, Protocols",
      map
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("title_match");
    expect(out[0]!.similarity).toBe(1.0);
    expect(out[0]!.basename).toBe("how-the-internet-works-http-html-protocols");
  });

  it("kebab_match: matches without normalization round-trip", () => {
    const map = makeMap(["fp-vs-oop-trade-offs"]);
    const out = findCandidates("FP vs OOP — Trade-offs", map);
    expect(out[0]!.reason).toBe("title_match");
  });

  it("kebab_match wins when title_match doesn't apply", () => {
    const map = makeMap(["fp-vs-oop-trade-offs"]);
    const out = findCandidates("fp-vs-oop-trade-offs-extra", map);
    expect(out[0]!.reason).not.toBe("title_match");
  });

  it("levenshtein: one-char typo", () => {
    const map = makeMap(["algorithm-complexity-big-o"]);
    const out = findCandidates("algorithm-complexity-bg-o", map);
    expect(out[0]!.reason).toBe("levenshtein");
    expect(out[0]!.similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("levenshtein rejected when distance too large", () => {
    const map = makeMap(["bar-baz-qux"]);
    const out = findCandidates("foo", map);
    expect(out.find((c) => c.reason === "levenshtein")).toBeUndefined();
  });

  it("substring: short target inside longer basename when length ratio >= 0.5", () => {
    const map = makeMap(["dom-rendering"]);
    const out = findCandidates("dom-render", map);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe("substring");
    expect(out[0]!.similarity).toBeGreaterThanOrEqual(0.5);
    expect(out[0]!.similarity).toBeLessThan(1.0);
  });

  it("substring rejected when shorter < 50% of longer", () => {
    const map = makeMap(["a-very-long-basename-with-many-words"]);
    const out = findCandidates("a", map);
    expect(out).toHaveLength(0);
  });

  it("DOM vs dom-rendering: too short → phantom (no candidate above floor)", () => {
    const map = makeMap(["dom-rendering"]);
    const out = findCandidates("DOM", map);
    expect(out).toHaveLength(0);
  });

  it("phantom: unrelated target returns no candidates", () => {
    const map = makeMap(["how-the-internet-works", "dom-rendering"]);
    const out = findCandidates("completely-unrelated-thing", map);
    expect(out).toHaveLength(0);
  });

  it("empty target returns no candidates", () => {
    const map = makeMap(["anything"]);
    expect(findCandidates("", map)).toHaveLength(0);
    expect(findCandidates("---", map)).toHaveLength(0);
  });

  it("caps at top 3 and sorts by similarity descending", () => {
    const map = makeMap([
      "how-the-internet-works",
      "how-the-internet-works-essentials",
      "how-the-internet-works-deep-dive",
      "how-the-internet-works-quickstart",
      "how-the-internet-works-summary",
    ]);
    const out = findCandidates("how-the-internet-works", map);
    expect(out.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1]!.similarity).toBeGreaterThanOrEqual(out[i]!.similarity);
    }
    expect(out[0]!.basename).toBe("how-the-internet-works");
  });
});

describe("classifyBroken", () => {
  it("title_match → title_form, high confidence", () => {
    const c = classifyBroken([
      {
        basename: "x",
        path: "x.md",
        similarity: 1.0,
        reason: "title_match",
      },
    ]);
    expect(c.classification).toBe("title_form");
    expect(c.suggestedFix.action).toBe("rewrite_to");
    expect(c.suggestedFix.target_basename).toBe("x");
    expect(c.suggestedFix.confidence).toBe("high");
  });

  it("kebab_match with sim 0.95 → title_form, high", () => {
    const c = classifyBroken([
      {
        basename: "x",
        path: "x.md",
        similarity: 0.95,
        reason: "kebab_match",
      },
    ]);
    expect(c.classification).toBe("title_form");
    expect(c.suggestedFix.confidence).toBe("high");
  });

  it("levenshtein sim >= 0.85 → typo, high", () => {
    const c = classifyBroken([
      {
        basename: "x",
        path: "x.md",
        similarity: 0.88,
        reason: "levenshtein",
      },
    ]);
    expect(c.classification).toBe("typo");
    expect(c.suggestedFix.confidence).toBe("high");
  });

  it("levenshtein 0.75 ≤ sim < 0.85 → typo, medium", () => {
    const c = classifyBroken([
      {
        basename: "x",
        path: "x.md",
        similarity: 0.78,
        reason: "levenshtein",
      },
    ]);
    expect(c.classification).toBe("typo");
    expect(c.suggestedFix.confidence).toBe("medium");
  });

  it("substring only → phantom, no_clear_match", () => {
    const c = classifyBroken([
      {
        basename: "x",
        path: "x.md",
        similarity: 0.6,
        reason: "substring",
      },
    ]);
    expect(c.classification).toBe("phantom");
    expect(c.suggestedFix.action).toBe("no_clear_match");
    expect(c.suggestedFix.confidence).toBe("low");
  });

  it("no candidates → phantom, low", () => {
    const c = classifyBroken([]);
    expect(c.classification).toBe("phantom");
    expect(c.suggestedFix.action).toBe("no_clear_match");
    expect(c.suggestedFix.confidence).toBe("low");
  });
});
