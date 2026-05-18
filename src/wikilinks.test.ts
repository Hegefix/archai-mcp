import { describe, it, expect } from "vitest";
import {
  scanLinks,
  rewriteWikilinks,
  rewriteMarkdownLinks,
  applyEdits,
  contextSnippet,
} from "./wikilinks.js";

describe("scanLinks — wikilinks", () => {
  it("detects a plain wikilink", () => {
    const refs = scanLinks("see [[foo]] here");
    expect(refs).toHaveLength(1);
    const ref = refs[0]!;
    expect(ref.kind).toBe("wikilink");
    expect(ref.basename).toBe("foo");
    expect(ref.target).toBe("foo");
    expect(ref.alias).toBeNull();
    expect(ref.heading).toBeNull();
    expect(ref.blockId).toBeNull();
    expect(ref.raw).toBe("[[foo]]");
    expect(ref.line).toBe(1);
    expect(ref.column).toBe(5);
  });

  it("detects an embed", () => {
    const refs = scanLinks("![[foo]]");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe("wikilink_embed");
    expect(refs[0]!.basename).toBe("foo");
    expect(refs[0]!.raw).toBe("![[foo]]");
  });

  it("parses aliased wikilink", () => {
    const refs = scanLinks("[[foo|display text]]");
    expect(refs[0]!.basename).toBe("foo");
    expect(refs[0]!.alias).toBe("display text");
  });

  it("parses heading reference", () => {
    const refs = scanLinks("[[foo#Some Heading]]");
    expect(refs[0]!.basename).toBe("foo");
    expect(refs[0]!.heading).toBe("Some Heading");
    expect(refs[0]!.blockId).toBeNull();
  });

  it("parses block reference", () => {
    const refs = scanLinks("[[foo#^abc123]]");
    expect(refs[0]!.basename).toBe("foo");
    expect(refs[0]!.blockId).toBe("abc123");
    expect(refs[0]!.heading).toBeNull();
  });

  it("parses heading + alias together", () => {
    const refs = scanLinks("[[foo#Heading|alt]]");
    expect(refs[0]!.basename).toBe("foo");
    expect(refs[0]!.heading).toBe("Heading");
    expect(refs[0]!.alias).toBe("alt");
  });

  it("strips path prefix from wikilink target to derive basename", () => {
    const refs = scanLinks("[[folder/note]]");
    expect(refs[0]!.basename).toBe("note");
    expect(refs[0]!.target).toBe("folder/note");
  });

  it("strips .md suffix from wikilink target", () => {
    const refs = scanLinks("[[note.md]]");
    expect(refs[0]!.basename).toBe("note");
  });

  it("detects multiple wikilinks on one line", () => {
    const refs = scanLinks("see [[a]] and [[b]] together");
    expect(refs).toHaveLength(2);
    expect(refs[0]!.basename).toBe("a");
    expect(refs[1]!.basename).toBe("b");
  });

  it("detects adjacent wikilinks with no separator", () => {
    const refs = scanLinks("[[a]][[b]]");
    expect(refs).toHaveLength(2);
  });
});

describe("scanLinks — markdown links", () => {
  it("detects markdown link to .md file", () => {
    const refs = scanLinks("[label](./folder/note.md)");
    expect(refs).toHaveLength(1);
    const ref = refs[0]!;
    expect(ref.kind).toBe("markdown");
    expect(ref.target).toBe("./folder/note.md");
    expect(ref.basename).toBe("note");
  });

  it("includes non-md markdown links but marks basename null", () => {
    const refs = scanLinks("[home](https://example.com)");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.kind).toBe("markdown");
    expect(refs[0]!.target).toBe("https://example.com");
    expect(refs[0]!.basename).toBeNull();
  });

  it("decodes percent-escaped basenames", () => {
    const refs = scanLinks("[x](./folder/some%20note.md)");
    expect(refs[0]!.basename).toBe("some note");
  });
});

describe("scanLinks — exclusions", () => {
  it("ignores wikilinks inside inline code", () => {
    const refs = scanLinks("text `[[foo]]` more");
    expect(refs).toHaveLength(0);
  });

  it("ignores wikilinks inside fenced code blocks", () => {
    const refs = scanLinks("text\n```\n[[foo]]\n```\nafter");
    expect(refs).toHaveLength(0);
  });

  it("ignores wikilinks inside tilde-fenced code blocks", () => {
    const refs = scanLinks("text\n~~~\n[[foo]]\n~~~\nafter");
    expect(refs).toHaveLength(0);
  });

  it("ignores wikilinks inside indented code blocks", () => {
    const refs = scanLinks("text\n\n    [[foo]]\n\nafter");
    expect(refs).toHaveLength(0);
  });

  it("ignores wikilinks inside YAML frontmatter", () => {
    const refs = scanLinks(
      "---\ntitle: \"[[foo]]\"\ntags: [bar]\n---\nbody [[real]]"
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.basename).toBe("real");
  });

  it("ignores escaped brackets", () => {
    const refs = scanLinks("text \\[\\[foo\\]\\] more");
    expect(refs).toHaveLength(0);
  });

  it("does not span newlines inside a wikilink", () => {
    const refs = scanLinks("[[foo\nbar]]");
    expect(refs).toHaveLength(0);
  });
});

describe("scanLinks — positions", () => {
  it("reports correct line and column on multi-line input", () => {
    const refs = scanLinks("line one\nline two has [[link]] in it\nline three");
    expect(refs[0]!.line).toBe(2);
    expect(refs[0]!.column).toBe(14);
  });

  it("handles unicode characters before the link", () => {
    const content = "🎉 see [[foo]]";
    const refs = scanLinks(content);
    expect(refs).toHaveLength(1);
    const ref = refs[0]!;
    expect(content.slice(ref.offset, ref.offset + ref.length)).toBe("[[foo]]");
  });

  it("offsets are sorted ascending", () => {
    const refs = scanLinks("[[c]] [[a]] [[b]]");
    expect(refs.map((r) => r.basename)).toEqual(["c", "a", "b"]);
    expect(refs[0]!.offset).toBeLessThan(refs[1]!.offset);
    expect(refs[1]!.offset).toBeLessThan(refs[2]!.offset);
  });
});

describe("rewriteWikilinks", () => {
  it("rewrites a plain wikilink target", () => {
    const out = rewriteWikilinks("see [[old]] now", "old", "new");
    expect(out.content).toBe("see [[new]] now");
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0]!.replacement).toBe("[[new]]");
  });

  it("preserves alias", () => {
    const out = rewriteWikilinks("[[old|display]]", "old", "new");
    expect(out.content).toBe("[[new|display]]");
  });

  it("preserves heading", () => {
    const out = rewriteWikilinks("[[old#Heading]]", "old", "new");
    expect(out.content).toBe("[[new#Heading]]");
  });

  it("preserves block id", () => {
    const out = rewriteWikilinks("[[old#^id]]", "old", "new");
    expect(out.content).toBe("[[new#^id]]");
  });

  it("preserves combined heading + alias", () => {
    const out = rewriteWikilinks("[[old#H|alt]]", "old", "new");
    expect(out.content).toBe("[[new#H|alt]]");
  });

  it("rewrites embeds", () => {
    const out = rewriteWikilinks("![[old]]", "old", "new");
    expect(out.content).toBe("![[new]]");
  });

  it("leaves unrelated wikilinks alone", () => {
    const out = rewriteWikilinks("[[other]] [[old]]", "old", "new");
    expect(out.content).toBe("[[other]] [[new]]");
  });

  it("preserves surrounding bytes exactly outside the rewritten spans", () => {
    const content = "  weird   whitespace\n\n\n[[old]]\t\tand more\n";
    const out = rewriteWikilinks(content, "old", "new");
    expect(out.content).toBe("  weird   whitespace\n\n\n[[new]]\t\tand more\n");
  });

  it("is a no-op when from === to", () => {
    const out = rewriteWikilinks("[[same]]", "same", "same");
    expect(out.content).toBe("[[same]]");
    expect(out.updates).toEqual([]);
  });

  it("skips wikilinks in code", () => {
    const out = rewriteWikilinks("real [[old]] code `[[old]]`", "old", "new");
    expect(out.content).toBe("real [[new]] code `[[old]]`");
  });

  it("rewrites multiple occurrences on one line", () => {
    const out = rewriteWikilinks("[[old]] then [[old]]", "old", "new");
    expect(out.content).toBe("[[new]] then [[new]]");
    expect(out.updates).toHaveLength(2);
  });
});

describe("rewriteMarkdownLinks", () => {
  it("rewrites a markdown link URL when predicate returns a new value", () => {
    const out = rewriteMarkdownLinks(
      "[x](./old.md)",
      (url) => (url === "./old.md" ? "./new.md" : null)
    );
    expect(out.content).toBe("[x](./new.md)");
  });

  it("leaves link untouched when predicate returns null", () => {
    const out = rewriteMarkdownLinks("[x](./old.md)", () => null);
    expect(out.content).toBe("[x](./old.md)");
    expect(out.updates).toEqual([]);
  });

  it("preserves link text including brackets-like content", () => {
    const out = rewriteMarkdownLinks(
      "[a (with parens) b](./x.md)",
      () => "./y.md"
    );
    expect(out.content).toBe("[a (with parens) b](./y.md)");
  });
});

describe("applyEdits", () => {
  it("returns input unchanged for empty edits", () => {
    expect(applyEdits("hello", [])).toBe("hello");
  });

  it("applies non-overlapping edits", () => {
    const out = applyEdits("aaa bbb ccc", [
      { offset: 0, length: 3, replacement: "AAA" },
      { offset: 8, length: 3, replacement: "CCC" },
    ]);
    expect(out).toBe("AAA bbb CCC");
  });

  it("throws on overlapping edits", () => {
    expect(() =>
      applyEdits("aaaa", [
        { offset: 0, length: 2, replacement: "x" },
        { offset: 1, length: 2, replacement: "y" },
      ])
    ).toThrow("overlapping edits");
  });

  it("throws on adjacent-but-overlapping zero-length edge case", () => {
    expect(() =>
      applyEdits("aaa", [
        { offset: 0, length: 2, replacement: "x" },
        { offset: 1, length: 1, replacement: "y" },
      ])
    ).toThrow("overlapping edits");
  });

  it("handles edits given in any order", () => {
    const out = applyEdits("aaa bbb ccc", [
      { offset: 8, length: 3, replacement: "CCC" },
      { offset: 0, length: 3, replacement: "AAA" },
    ]);
    expect(out).toBe("AAA bbb CCC");
  });
});

describe("contextSnippet", () => {
  it("returns content around the offset", () => {
    const content = "a".repeat(50) + "[[link]]" + "b".repeat(50);
    const snippet = contextSnippet(content, 50, 8, 40);
    expect(snippet).toContain("[[link]]");
    expect(snippet).toContain("...");
  });

  it("replaces newlines with spaces", () => {
    const snippet = contextSnippet("foo\nbar\nbaz", 4, 3, 20);
    expect(snippet).not.toContain("\n");
    expect(snippet).toContain("bar");
  });
});
