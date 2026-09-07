import { describe, it, expect } from "vitest";
import {
  buildVaultIndex,
  resolveTarget,
  basenameSimilarity,
  suggestTarget,
  classifyLink,
  summarize,
  PLANNED_MARKER,
} from "./lint-candidates.js";
import { scanWikilinks, type Wikilink } from "./wikilinks.js";

/** The single link in `source`, so classification tests read as prose. */
function link(source: string): Wikilink {
  const [first] = scanWikilinks(source);
  if (first === undefined) throw new Error(`no link in: ${source}`);
  return first;
}

const tech = buildVaultIndex("tech", [
  "concepts/react/react-query.md",
  "concepts/react/react-reconciliation.md",
  "patterns/karpathy-llm-output-as-html.md",
  "shared.md",
  "deep/shared.md",
]);
const work = buildVaultIndex("work", ["mobile/stack-state.md", "me/growth-log.md"]);

const context = (index = tech, renames = new Map<string, string>()) => ({
  index,
  others: [index === tech ? work : tech],
  renames,
});

describe("resolveTarget", () => {
  it("resolves a bare basename anywhere in the vault", () => {
    expect(resolveTarget(tech, "react-query")).toBe("concepts/react/react-query");
  });

  it("resolves a full vault-relative path", () => {
    expect(resolveTarget(tech, "concepts/react/react-query")).toBe(
      "concepts/react/react-query"
    );
  });

  it("falls back to the basename when the folder prefix is wrong", () => {
    expect(resolveTarget(tech, "wrong/folder/react-query")).toBe(
      "concepts/react/react-query"
    );
  });

  it("tolerates an explicit .md extension", () => {
    expect(resolveTarget(tech, "react-query.md")).toBe("concepts/react/react-query");
  });

  it("returns undefined for a target that isn't there", () => {
    expect(resolveTarget(tech, "no-such-note")).toBeUndefined();
  });
});

describe("basenameSimilarity", () => {
  it("scores an identical name 1", () => {
    expect(basenameSimilarity("a-b", "a-b")).toBe(1);
  });

  it("scores a qualified rename highly via token containment", () => {
    expect(
      basenameSimilarity("stack-state", "goodhabitz-mobile-stack-state")
    ).toBeGreaterThanOrEqual(0.75);
  });

  it("does not let a single short token claim a longer name", () => {
    expect(basenameSimilarity("react", "react-query")).toBeLessThan(0.75);
  });

  it("scores a suffix change highly", () => {
    expect(basenameSimilarity("react-optimisation", "react-optimization")).toBeGreaterThan(
      0.75
    );
  });

  it("scores unrelated names low", () => {
    expect(basenameSimilarity("js-closures", "docker-networking")).toBeLessThan(0.4);
  });
});

describe("suggestTarget", () => {
  it("trusts git rename history over similarity", () => {
    const renames = new Map([["old-name", "react-query"]]);
    const { suggestion } = suggestTarget(tech, "old-name", renames);
    expect(suggestion).toMatchObject({
      target: "concepts/react/react-query",
      source: "git-rename",
    });
  });

  it("ignores rename history pointing at a note that no longer exists", () => {
    const renames = new Map([["old-name", "also-gone"]]);
    expect(suggestTarget(tech, "old-name", renames).suggestion).toBeUndefined();
  });

  it("suggests a near match by basename similarity", () => {
    const { suggestion } = suggestTarget(tech, "react-reconcilation", new Map());
    expect(suggestion).toMatchObject({
      target: "concepts/react/react-reconciliation",
      source: "basename-similarity",
    });
  });

  it("suggests nothing for a name with no plausible match", () => {
    const result = suggestTarget(tech, "completely-unrelated-thing", new Map());
    expect(result.suggestion).toBeUndefined();
    expect(result.ambiguous).toBeUndefined();
  });

  it("reports a tie as ambiguous rather than picking one", () => {
    // Both candidates are one insertion away from the query, so neither is a
    // better guess than the other and a bulk rewrite must not pick for the caller.
    const index = buildVaultIndex("t", ["alpha-notes.md", "alpha-noted.md"]);
    const result = suggestTarget(index, "alpha-note", new Map());
    expect(result.suggestion).toBeUndefined();
    expect(result.ambiguous).toEqual(["alpha-noted", "alpha-notes"]);
  });
});

describe("classifyLink", () => {
  it("classifies a resolving link as ok", () => {
    const finding = classifyLink(link("[[react-query]]"), "a.md", context());
    expect(finding).toMatchObject({ class: "ok", resolved: "concepts/react/react-query" });
  });

  // Both vaults are separate Obsidian roots, so a link across them cannot resolve
  // and must never be "repaired" into pointing at a local note.
  it("classifies a link to a note in another vault as external", () => {
    const finding = classifyLink(link("[[stack-state]]"), "a.md", context());
    expect(finding).toMatchObject({ class: "external", externalVault: "work" });
  });

  it("classifies external in the other direction too", () => {
    const finding = classifyLink(link("[[react-query]]"), "a.md", context(work));
    expect(finding).toMatchObject({ class: "external", externalVault: "tech" });
  });

  it("does not suggest a local rename for a cross-vault link", () => {
    const finding = classifyLink(link("[[growth-log]]"), "a.md", context());
    expect(finding.class).toBe("external");
    expect(finding.suggestion).toBeUndefined();
  });

  it(`classifies a dangling link marked ${PLANNED_MARKER} as planned`, () => {
    const finding = classifyLink(
      link(`- [[mvc-flux-and-state-management]] ${PLANNED_MARKER}`),
      "a.md",
      context()
    );
    expect(finding).toMatchObject({ class: "planned" });
  });

  it("lets the planned marker win over a rename suggestion", () => {
    const finding = classifyLink(
      link(`- [[react-reconcilation]] ${PLANNED_MARKER}`),
      "a.md",
      context()
    );
    expect(finding.class).toBe("planned");
    expect(finding.suggestion).toBeUndefined();
  });

  it("reports a resolving link as ok even when the line carries the marker", () => {
    const finding = classifyLink(
      link(`- [[react-query]] ${PLANNED_MARKER}`),
      "a.md",
      context()
    );
    expect(finding.class).toBe("ok");
  });

  it("classifies a dangling link with a near match as renamed-candidate", () => {
    const finding = classifyLink(link("[[react-reconcilation]]"), "a.md", context());
    expect(finding).toMatchObject({
      class: "renamed-candidate",
      suggestion: "concepts/react/react-reconciliation",
      suggestionSource: "basename-similarity",
    });
  });

  it("classifies a dangling link with nothing to suggest as broken", () => {
    const finding = classifyLink(link("[[totally-made-up-note]]"), "a.md", context());
    expect(finding).toMatchObject({ class: "broken" });
    expect(finding.suggestion).toBeUndefined();
  });

  it("carries the note path and line into the finding", () => {
    const finding = classifyLink(link("\n\n[[nope-nothing-here]]"), "dir/a.md", context());
    expect(finding).toMatchObject({ file: "dir/a.md", line: 3, vault: "tech" });
  });
});

describe("summarize", () => {
  it("counts every class, including the empty ones", () => {
    const findings = [
      classifyLink(link("[[react-query]]"), "a.md", context()),
      classifyLink(link("[[stack-state]]"), "a.md", context()),
      classifyLink(link("[[totally-made-up-note]]"), "a.md", context()),
    ];
    expect(summarize(findings)).toEqual({
      ok: 1,
      planned: 0,
      external: 1,
      "renamed-candidate": 0,
      broken: 1,
    });
  });
});
