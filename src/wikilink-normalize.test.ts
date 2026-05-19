import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { createServer } from "./server.js";
import {
  normalizeWikilinks,
  toWikilinkKebab,
} from "./wikilink-normalize.js";

describe("toWikilinkKebab", () => {
  it("lowercases and replaces spaces", () => {
    expect(toWikilinkKebab("React Native Performance")).toBe(
      "react-native-performance"
    );
  });

  it("replaces em-dash and en-dash with hyphen", () => {
    expect(toWikilinkKebab("FP vs OOP — Trade-offs")).toBe(
      "fp-vs-oop-trade-offs"
    );
    expect(toWikilinkKebab("A – B")).toBe("a-b");
  });

  it("strips diacritics", () => {
    expect(toWikilinkKebab("Café Naïve")).toBe("cafe-naive");
  });

  it("strips punctuation and collapses dashes", () => {
    expect(toWikilinkKebab("HTTP, HTML & Protocols!")).toBe(
      "http-html-protocols"
    );
  });

  it("trims leading and trailing dashes", () => {
    expect(toWikilinkKebab("  --foo--  ")).toBe("foo");
  });
});

describe("normalizeWikilinks (unit)", () => {
  it("rewrites title-form wikilinks to kebab-case", () => {
    const { content, changes } = normalizeWikilinks(
      "See [[Pretty Title]] and done."
    );
    expect(content).toBe("See [[pretty-title]] and done.");
    expect(changes).toEqual([
      { from: "[[Pretty Title]]", to: "[[pretty-title]]" },
    ]);
  });

  it("preserves alias and heading fragments", () => {
    const { content } = normalizeWikilinks(
      "[[HTTP — Protocol Deep Dive|HTTP]] and [[Pretty Title#Critical path]]"
    );
    expect(content).toBe(
      "[[http-protocol-deep-dive|HTTP]] and [[pretty-title#Critical path]]"
    );
  });

  it("preserves block id fragments", () => {
    const { content } = normalizeWikilinks("[[Some Note#^abc-123]]");
    expect(content).toBe("[[some-note#^abc-123]]");
  });

  it("skips already-kebab targets", () => {
    const { content, changes } = normalizeWikilinks(
      "Refs [[already-kebab-link]] and [[a]] singletons."
    );
    expect(content).toBe("Refs [[already-kebab-link]] and [[a]] singletons.");
    expect(changes).toEqual([]);
  });

  it("skips targets with path prefix", () => {
    const { changes } = normalizeWikilinks(
      "See [[public/learning/foo]] and [[_attachments/letter.pdf]]."
    );
    expect(changes).toEqual([]);
  });

  it("skips attachment extensions in basename form", () => {
    const { changes } = normalizeWikilinks(
      "Image: [[image.png]] and [[Letter.PDF]]."
    );
    expect(changes).toEqual([]);
  });

  it("skips wikilinks inside fenced code blocks", () => {
    const src = [
      "Real: [[Pretty Title]]",
      "",
      "```",
      "Anti-pattern: [[Bad Example]]",
      "```",
      "",
    ].join("\n");
    const { content, changes } = normalizeWikilinks(src);
    expect(content).toContain("[[pretty-title]]");
    expect(content).toContain("[[Bad Example]]");
    expect(changes).toHaveLength(1);
  });

  it("skips wikilinks inside inline code", () => {
    const { content, changes } = normalizeWikilinks(
      "Use `[[Bad Example]]` not [[Pretty Title]]."
    );
    expect(content).toContain("`[[Bad Example]]`");
    expect(content).toContain("[[pretty-title]]");
    expect(changes).toHaveLength(1);
  });

  it("normalizes embed wikilinks", () => {
    const { content } = normalizeWikilinks("![[Some Title]]");
    expect(content).toBe("![[some-title]]");
  });

  it("normalizes multiple wikilinks on the same line", () => {
    const { content, changes } = normalizeWikilinks(
      "Both [[First Thing]] and [[Second Thing]] here."
    );
    expect(content).toBe("Both [[first-thing]] and [[second-thing]] here.");
    expect(changes).toHaveLength(2);
  });
});

describe("save — wikilink normalization", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "archai-norm-save-"));
    const server = createServer(vault);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await rm(vault, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await close();
  });

  async function callSave(args: Record<string, unknown>) {
    return client.callTool({ name: "save", arguments: args });
  }

  async function readBody(rel: string): Promise<string> {
    const raw = await readFile(join(vault, rel), "utf-8");
    return matter(raw).content.trim();
  }

  it("normalizes_title_form_wikilinks", async () => {
    await callSave({
      title: "Host",
      content: "See [[Pretty Title]] for details.",
      folder: "public/tech",
      force: true,
    });
    expect(await readBody("public/tech/host.md")).toBe(
      "See [[pretty-title]] for details."
    );
  });

  it("preserves_aliases_and_headings", async () => {
    await callSave({
      title: "Host",
      content:
        "[[Pretty Title|alias text]] and [[Pretty Title#Heading]] both work.",
      folder: "public/tech",
      force: true,
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toContain("[[pretty-title|alias text]]");
    expect(body).toContain("[[pretty-title#Heading]]");
  });

  it("skips_already_kebab", async () => {
    const res = await callSave({
      title: "Host",
      content: "Link [[already-kebab-link]] stays.",
      folder: "public/tech",
      force: true,
    });
    expect(await readBody("public/tech/host.md")).toBe(
      "Link [[already-kebab-link]] stays."
    );
    const structured = res.structuredContent as {
      normalized_wikilinks: Array<unknown>;
    };
    expect(structured.normalized_wikilinks).toEqual([]);
  });

  it("skips_attachments", async () => {
    await callSave({
      title: "Host",
      content: "PDF [[_attachments/file.pdf]] and image [[image.png]] here.",
      folder: "public/tech",
      force: true,
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toContain("[[_attachments/file.pdf]]");
    expect(body).toContain("[[image.png]]");
  });

  it("skips_code_blocks", async () => {
    await callSave({
      title: "Host",
      content: [
        "Real link [[Real Target]] here.",
        "",
        "```",
        "Anti-pattern: [[Bad Example]]",
        "```",
        "",
      ].join("\n"),
      folder: "public/tech",
      force: true,
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toContain("[[real-target]]");
    expect(body).toContain("[[Bad Example]]");
  });

  it("skips_inline_code", async () => {
    await callSave({
      title: "Host",
      content: "Use `[[Bad Example]]` not [[Real One]].",
      folder: "public/tech",
      force: true,
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toContain("`[[Bad Example]]`");
    expect(body).toContain("[[real-one]]");
  });

  it("opt_out_flag_works", async () => {
    await callSave({
      title: "Host",
      content: "Preserve [[Pretty Title]] exactly.",
      folder: "public/tech",
      force: true,
      normalize_wikilinks: false,
    });
    expect(await readBody("public/tech/host.md")).toBe(
      "Preserve [[Pretty Title]] exactly."
    );
  });

  it("multiple_wikilinks_per_line", async () => {
    const res = await callSave({
      title: "Host",
      content: "Both [[First Thing]] and [[Second Thing]] here.",
      folder: "public/tech",
      force: true,
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toBe("Both [[first-thing]] and [[second-thing]] here.");
    const structured = res.structuredContent as {
      normalized_wikilinks: Array<{ from: string; to: string }>;
    };
    expect(structured.normalized_wikilinks).toHaveLength(2);
  });

  it("structured_output_contains_changes", async () => {
    const res = await callSave({
      title: "Host",
      content: "Link [[HTTP — Protocol Deep Dive]] here.",
      folder: "public/tech",
      force: true,
    });
    const structured = res.structuredContent as {
      path: string;
      normalized_wikilinks: Array<{ from: string; to: string }>;
    };
    expect(structured.path).toBe("public/tech/host.md");
    expect(structured.normalized_wikilinks).toEqual([
      {
        from: "[[HTTP — Protocol Deep Dive]]",
        to: "[[http-protocol-deep-dive]]",
      },
    ]);
  });

  it("text_output_summary_format", async () => {
    const res = await callSave({
      title: "Host",
      content: "Refs [[Alpha Link]] and [[Beta Link]] sometimes.",
      folder: "public/tech",
      force: true,
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    expect(text).toContain("Created: public/tech/host.md");
    expect(text).toContain("Normalized 2 wikilinks:");
    expect(text).toContain("[[Alpha Link]] → [[alpha-link]]");
    expect(text).toContain("[[Beta Link]] → [[beta-link]]");
  });

  it("no_normalization_line_when_nothing_changed", async () => {
    const res = await callSave({
      title: "Host",
      content: "Refs [[already-kebab]] only.",
      folder: "public/tech",
      force: true,
    });
    const content = res.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toBe("Created: public/tech/host.md");
  });
});

describe("update — wikilink normalization", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "archai-norm-update-"));
    const server = createServer(vault);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await rm(vault, { recursive: true, force: true });
    };
    await client.callTool({
      name: "save",
      arguments: {
        title: "Host",
        content: "Initial body.",
        folder: "public/tech",
        force: true,
      },
    });
  });

  afterEach(async () => {
    await close();
  });

  async function callUpdate(args: Record<string, unknown>) {
    return client.callTool({ name: "update", arguments: args });
  }

  async function readBody(rel: string): Promise<string> {
    const raw = await readFile(join(vault, rel), "utf-8");
    return matter(raw).content.trim();
  }

  it("normalizes_title_form_wikilinks", async () => {
    await callUpdate({
      path: "public/tech/host.md",
      content: "Now references [[Pretty Title]].",
    });
    expect(await readBody("public/tech/host.md")).toBe(
      "Now references [[pretty-title]]."
    );
  });

  it("preserves_aliases_and_headings", async () => {
    await callUpdate({
      path: "public/tech/host.md",
      content:
        "[[Pretty Title|alias text]] and [[Pretty Title#Heading]] linked.",
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toContain("[[pretty-title|alias text]]");
    expect(body).toContain("[[pretty-title#Heading]]");
  });

  it("skips_already_kebab", async () => {
    const res = await callUpdate({
      path: "public/tech/host.md",
      content: "Link [[already-kebab]] here.",
    });
    const structured = res.structuredContent as {
      normalized_wikilinks: Array<unknown>;
    };
    expect(structured.normalized_wikilinks).toEqual([]);
  });

  it("skips_attachments", async () => {
    await callUpdate({
      path: "public/tech/host.md",
      content: "PDF [[_attachments/file.pdf]] and image [[image.png]] here.",
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toContain("[[_attachments/file.pdf]]");
    expect(body).toContain("[[image.png]]");
  });

  it("skips_code_blocks", async () => {
    await callUpdate({
      path: "public/tech/host.md",
      content: [
        "Real link [[Real Target]] here.",
        "",
        "```",
        "Anti-pattern: [[Bad Example]]",
        "```",
        "",
      ].join("\n"),
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toContain("[[real-target]]");
    expect(body).toContain("[[Bad Example]]");
  });

  it("skips_inline_code", async () => {
    await callUpdate({
      path: "public/tech/host.md",
      content: "Use `[[Bad Example]]` not [[Real One]].",
    });
    const body = await readBody("public/tech/host.md");
    expect(body).toContain("`[[Bad Example]]`");
    expect(body).toContain("[[real-one]]");
  });

  it("opt_out_flag_works", async () => {
    await callUpdate({
      path: "public/tech/host.md",
      content: "Preserve [[Pretty Title]] exactly.",
      normalize_wikilinks: false,
    });
    expect(await readBody("public/tech/host.md")).toBe(
      "Preserve [[Pretty Title]] exactly."
    );
  });

  it("multiple_wikilinks_per_line", async () => {
    const res = await callUpdate({
      path: "public/tech/host.md",
      content: "Both [[First Thing]] and [[Second Thing]] here.",
    });
    expect(await readBody("public/tech/host.md")).toBe(
      "Both [[first-thing]] and [[second-thing]] here."
    );
    const structured = res.structuredContent as {
      normalized_wikilinks: Array<{ from: string; to: string }>;
    };
    expect(structured.normalized_wikilinks).toHaveLength(2);
  });

  it("structured_output_contains_changes", async () => {
    const res = await callUpdate({
      path: "public/tech/host.md",
      content: "Link [[HTTP — Protocol Deep Dive]] here.",
    });
    const structured = res.structuredContent as {
      path: string;
      normalized_wikilinks: Array<{ from: string; to: string }>;
    };
    expect(structured.path).toBe("public/tech/host.md");
    expect(structured.normalized_wikilinks).toEqual([
      {
        from: "[[HTTP — Protocol Deep Dive]]",
        to: "[[http-protocol-deep-dive]]",
      },
    ]);
  });

  it("text_output_summary_format", async () => {
    const res = await callUpdate({
      path: "public/tech/host.md",
      content: "Refs [[Alpha Link]] and [[Beta Link]] sometimes.",
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    expect(text).toContain("Updated: public/tech/host.md");
    expect(text).toContain("Normalized 2 wikilinks:");
    expect(text).toContain("[[Alpha Link]] → [[alpha-link]]");
    expect(text).toContain("[[Beta Link]] → [[beta-link]]");
  });
});
