import { describe, it, expect } from "vitest";
import { scanWikilinks, rewriteWikilinks, renderWikilink } from "./wikilinks.js";

const targets = (source: string): string[] => scanWikilinks(source).map((l) => l.target);

describe("scanWikilinks", () => {
  it("reads the four shapes a link to one note can take", () => {
    const links = scanWikilinks(
      "[[bare]]\n[[mobile/prefixed]]\n[[aliased|Some Label]]\n[[anchored#Some Heading]]\n"
    );
    expect(links.map((l) => [l.target, l.alias, l.heading])).toEqual([
      ["bare", undefined, undefined],
      ["mobile/prefixed", undefined, undefined],
      ["aliased", "Some Label", undefined],
      ["anchored", undefined, "Some Heading"],
    ]);
  });

  it("keeps the alias when the heading and alias are combined", () => {
    const [link] = scanWikilinks("[[note#Heading|Label]]");
    expect(link).toMatchObject({ target: "note", heading: "Heading", alias: "Label" });
  });

  it("treats a pipe inside an alias as part of the alias, not a heading", () => {
    const [link] = scanWikilinks("[[note|A # B]]");
    expect(link).toMatchObject({ target: "note", alias: "A # B" });
    expect(link?.heading).toBeUndefined();
  });

  it("reports line numbers and the raw text as written", () => {
    const links = scanWikilinks("intro\n\nsee [[a/b|C]] here\n");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ line: 3, column: 5, raw: "[[a/b|C]]" });
  });

  // The live case: tech/patterns/karpathys-llm-knowledge-base-pattern.md documents
  // the pattern using a code span, and must not be read as a link to "wikilinks".
  it("ignores links inside an inline code span", () => {
    expect(
      targets("- [x] Compile flow: agent creates/updates notes with `[[wikilinks]]`\n")
    ).toEqual([]);
  });

  it("still reads a real link on a line that also has a code span", () => {
    expect(targets("`[[not-a-link]]` but [[a-real-one]] counts")).toEqual(["a-real-one"]);
  });

  it("handles double-backtick spans that themselves contain a backtick", () => {
    expect(targets("``code with ` and [[nope]]`` then [[yes]]")).toEqual(["yes"]);
  });

  it("treats an unclosed backtick as literal rather than swallowing the line", () => {
    expect(targets("a ` stray tick and [[still-a-link]]")).toEqual(["still-a-link"]);
  });

  it("ignores links inside a fenced code block", () => {
    const source = ["before [[one]]", "```md", "[[inside-fence]]", "```", "after [[two]]"].join(
      "\n"
    );
    expect(targets(source)).toEqual(["one", "two"]);
  });

  it("ignores links in a tilde fence and in an indented fence", () => {
    const source = ["~~~", "[[tilde]]", "~~~", "   ```", "   [[indented]]", "   ```", "[[kept]]"].join(
      "\n"
    );
    expect(targets(source)).toEqual(["kept"]);
  });

  it("does not let a shorter inner fence close a longer block", () => {
    const source = ["````", "```", "[[hidden]]", "```", "````", "[[kept]]"].join("\n");
    expect(targets(source)).toEqual(["kept"]);
  });

  it("ignores links in YAML frontmatter", () => {
    const source = ["---", "title: A", "related: [[frontmatter-link]]", "---", "[[body-link]]"].join(
      "\n"
    );
    expect(targets(source)).toEqual(["body-link"]);
  });

  it("does not mistake a horizontal rule mid-document for frontmatter", () => {
    expect(targets("intro\n\n---\n\n[[after-rule]]\n")).toEqual(["after-rule"]);
  });

  it("skips same-document anchors and empty links", () => {
    expect(targets("[[#Section]] and [[]] and [[real]]")).toEqual(["real"]);
  });

  it("reports an embed's target, leaving the bang outside the raw text", () => {
    const [link] = scanWikilinks("![[diagram]]");
    expect(link).toMatchObject({ target: "diagram", raw: "[[diagram]]" });
  });

  it("trims whitespace around a target but keeps the alias verbatim", () => {
    const [link] = scanWikilinks("[[  spaced  |  Label  ]]");
    expect(link).toMatchObject({ target: "spaced", alias: "  Label  " });
  });
});

describe("renderWikilink", () => {
  it("rebuilds each shape", () => {
    expect(renderWikilink("a")).toBe("[[a]]");
    expect(renderWikilink("a", "H")).toBe("[[a#H]]");
    expect(renderWikilink("a", undefined, "L")).toBe("[[a|L]]");
    expect(renderWikilink("a", "H", "L")).toBe("[[a#H|L]]");
  });
});

describe("rewriteWikilinks", () => {
  const swap = (from: string, to: string) => (link: { target: string }) =>
    link.target === from ? to : undefined;

  it("preserves the alias when retargeting", () => {
    const { content } = rewriteWikilinks("see [[old|Some Label]] here", swap("old", "new"));
    expect(content).toBe("see [[new|Some Label]] here");
  });

  it("preserves the heading when retargeting", () => {
    const { content } = rewriteWikilinks("see [[old#Section]] here", swap("old", "new"));
    expect(content).toBe("see [[new#Section]] here");
  });

  it("preserves a combined heading and alias", () => {
    const { content } = rewriteWikilinks("[[old#Section|Label]]", swap("old", "new"));
    expect(content).toBe("[[new#Section|Label]]");
  });

  it("rewrites a folder-prefixed link to the new target", () => {
    const { content } = rewriteWikilinks(
      "[[work/mobile/old]]",
      swap("work/mobile/old", "new")
    );
    expect(content).toBe("[[new]]");
  });

  it("rewrites every occurrence on one line without corrupting offsets", () => {
    const { content, changes } = rewriteWikilinks(
      "[[old]] then [[old|A]] then [[old#B]]",
      swap("old", "renamed-note")
    );
    expect(content).toBe("[[renamed-note]] then [[renamed-note|A]] then [[renamed-note#B]]");
    expect(changes).toHaveLength(3);
  });

  it("leaves links in code untouched even when they match", () => {
    const source = ["`[[old]]`", "```", "[[old]]", "```", "[[old]]"].join("\n");
    const { content, changes } = rewriteWikilinks(source, swap("old", "new"));
    expect(content).toBe(["`[[old]]`", "```", "[[old]]", "```", "[[new]]"].join("\n"));
    expect(changes).toHaveLength(1);
  });

  it("reports no changes when the target is unchanged", () => {
    const { content, changes } = rewriteWikilinks("[[same]]", swap("same", "same"));
    expect(changes).toEqual([]);
    expect(content).toBe("[[same]]");
  });

  it("returns changes in document order with their line numbers", () => {
    const { changes } = rewriteWikilinks("[[old]]\n\n[[old]]", swap("old", "new"));
    expect(changes.map((c) => c.link.line)).toEqual([1, 3]);
  });
});
