import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server.js";

async function setupVault(): Promise<{
  vault: string;
  client: Client;
  close: () => Promise<void>;
}> {
  const vault = await mkdtemp(join(tmpdir(), "archai-lint-test-"));
  const server = createServer(vault);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    vault,
    client,
    close: async () => {
      await client.close();
      await rm(vault, { recursive: true, force: true });
    },
  };
}

async function writeNote(vault: string, relPath: string, body: string): Promise<void> {
  const full = join(vault, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body, "utf-8");
}

async function writeAttachment(vault: string, relPath: string): Promise<void> {
  const full = join(vault, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, Buffer.alloc(0));
}

interface LintStructured {
  scanned_files: number;
  total_wikilinks: number;
  broken_count: number;
  broken_links: Array<{
    target: string;
    occurrences: Array<{
      path: string;
      line: number;
      column: number;
      raw: string;
      context: string;
    }>;
    classification: "title_form" | "typo" | "phantom" | "attachment_missing";
    candidates: Array<{
      basename: string;
      path: string;
      similarity: number;
      reason: string;
    }>;
    suggested_fix: {
      action: "rewrite_to" | "no_clear_match";
      target_basename?: string;
      confidence: "high" | "medium" | "low";
    };
  }>;
  summary: {
    by_classification: {
      title_form: number;
      typo: number;
      phantom: number;
      attachment_missing: number;
    };
    high_confidence_fixes: number;
    needs_user_decision: number;
  };
}

async function lint(
  client: Client,
  args: Record<string, unknown> = {}
): Promise<LintStructured> {
  const res = await client.callTool({ name: "lint_links", arguments: args });
  return res.structuredContent as unknown as LintStructured;
}

describe("lint_links", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, client, close } = await setupVault());

    await writeNote(
      vault,
      "public/how-the-internet-works-http-html-protocols.md",
      "Real note.\n"
    );
    await writeNote(
      vault,
      "public/algorithm-complexity-big-o.md",
      "Real note.\n"
    );
    await writeNote(vault, "public/dom-rendering.md", "Real note.\n");

    await writeNote(
      vault,
      "public/note-a.md",
      "Refs [[How the Internet Works — HTTP, HTML, Protocols]] here.\n"
    );
    await writeNote(
      vault,
      "public/note-b.md",
      "See [[algorithm-complexity-bg-o]] for details.\n"
    );
    await writeNote(
      vault,
      "public/note-c.md",
      "Mentions [[completely-unrelated-thing]] once.\n"
    );
    await writeNote(
      vault,
      "public/note-d.md",
      "Stub: [[future-concept]] <!-- intentional --> to be written.\n"
    );
    await writeNote(
      vault,
      "public/note-e.md",
      "Working [[how-the-internet-works-http-html-protocols]] link.\n"
    );
    await writeNote(
      vault,
      "private/note-f.md",
      "Private [[phantom-private]] broken link.\n"
    );
  });

  afterEach(async () => {
    await close();
  });

  it("default scan finds broken links (intentional skipped), classifications correct", async () => {
    const out = await lint(client);
    // 3 in public (title_form + typo + phantom) + 1 in private (phantom)
    expect(out.broken_count).toBe(4);

    const byTarget = new Map(out.broken_links.map((b) => [b.target, b]));

    const titleForm = byTarget.get("How the Internet Works — HTTP, HTML, Protocols");
    expect(titleForm?.classification).toBe("title_form");
    expect(titleForm?.suggested_fix.action).toBe("rewrite_to");
    expect(titleForm?.suggested_fix.target_basename).toBe(
      "how-the-internet-works-http-html-protocols"
    );
    expect(titleForm?.suggested_fix.confidence).toBe("high");

    const typo = byTarget.get("algorithm-complexity-bg-o");
    expect(typo?.classification).toBe("typo");
    expect(typo?.suggested_fix.action).toBe("rewrite_to");
    expect(typo?.suggested_fix.target_basename).toBe("algorithm-complexity-big-o");

    const phantom = byTarget.get("completely-unrelated-thing");
    expect(phantom?.classification).toBe("phantom");
    expect(phantom?.suggested_fix.action).toBe("no_clear_match");
    expect(phantom?.suggested_fix.confidence).toBe("low");

    expect(byTarget.has("future-concept")).toBe(false);

    expect(out.summary.by_classification.title_form).toBe(1);
    expect(out.summary.by_classification.typo).toBe(1);
    expect(out.summary.by_classification.phantom).toBe(2);
  });

  it("ignore_intentional=false surfaces the intentional stub", async () => {
    const out = await lint(client, { ignore_intentional: false });
    const targets = out.broken_links.map((b) => b.target);
    expect(targets).toContain("future-concept");
    expect(out.broken_count).toBe(5);
  });

  it("scope='public' excludes private folder broken links", async () => {
    const out = await lint(client, { scope: "public" });
    const targets = out.broken_links.map((b) => b.target);
    expect(targets).not.toContain("phantom-private");
    expect(targets).toContain("completely-unrelated-thing");
    expect(out.scanned_files).toBe(8);
  });

  it("scope='public/' (trailing slash) behaves the same", async () => {
    const out = await lint(client, { scope: "public/" });
    expect(out.scanned_files).toBe(8);
    expect(out.broken_links.map((b) => b.target)).not.toContain(
      "phantom-private"
    );
  });

  it("counts scanned_files and total_wikilinks correctly", async () => {
    const out = await lint(client);
    expect(out.scanned_files).toBe(9);
    expect(out.total_wikilinks).toBe(6);
  });

  it("occurrences carry path, line, column, raw, context", async () => {
    const out = await lint(client);
    const phantom = out.broken_links.find(
      (b) => b.target === "completely-unrelated-thing"
    );
    expect(phantom?.occurrences).toHaveLength(1);
    const occ = phantom!.occurrences[0]!;
    expect(occ.path).toBe("public/note-c.md");
    expect(occ.line).toBe(1);
    expect(occ.column).toBeGreaterThan(0);
    expect(occ.raw).toBe("[[completely-unrelated-thing]]");
    expect(occ.context).toContain("completely-unrelated-thing");
  });

  it("alias and heading variants dedupe under one broken target", async () => {
    await writeNote(
      vault,
      "public/aliases.md",
      "See [[completely-unrelated-thing|alias]] and [[completely-unrelated-thing#Heading]] both.\n"
    );
    const out = await lint(client);
    const phantom = out.broken_links.find(
      (b) => b.target === "completely-unrelated-thing"
    );
    expect(phantom?.occurrences.length).toBe(3);
  });

  it("intentional comment with extra whitespace still skips", async () => {
    await writeNote(
      vault,
      "public/note-g.md",
      "Stub: [[another-stub]]   <!--   intentional   --> later.\n"
    );
    const out = await lint(client);
    expect(out.broken_links.map((b) => b.target)).not.toContain("another-stub");
  });

  it("rejects scope traversal", async () => {
    const res = await client.callTool({
      name: "lint_links",
      arguments: { scope: "../escape" },
    });
    expect(res.isError).toBe(true);
  });

  it("summary high_confidence_fixes counts only high-confidence rewrites", async () => {
    const out = await lint(client);
    expect(out.summary.high_confidence_fixes).toBeGreaterThanOrEqual(1);
    expect(out.summary.needs_user_decision).toBeGreaterThanOrEqual(1);
  });
});

describe("lint_links — scope and code-block isolation", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, client, close } = await setupVault());
  });

  afterEach(async () => {
    await close();
  });

  it("scope_basename_resolution_full_vault: links resolve to files outside scope", async () => {
    await writeNote(vault, "a/foo.md", "Link: [[bar]] here.\n");
    await writeNote(vault, "b/bar.md", "Target.\n");
    const out = await lint(client, { scope: "a" });
    expect(out.broken_count).toBe(0);
    expect(out.total_wikilinks).toBe(1);
    expect(out.scanned_files).toBe(1);
  });

  it("wikilink_in_fenced_code_block_ignored", async () => {
    await writeNote(vault, "real.md", "Real target.\n");
    await writeNote(
      vault,
      "note.md",
      [
        "Real link: [[real]]",
        "",
        "```",
        "Example: [[fake-in-block]]",
        "```",
        "",
      ].join("\n")
    );
    const out = await lint(client);
    expect(out.total_wikilinks).toBe(1);
    expect(out.broken_count).toBe(0);
  });

  it("wikilink_in_inline_code_ignored", async () => {
    await writeNote(vault, "real.md", "Real target.\n");
    await writeNote(
      vault,
      "note.md",
      "Inline `[[fake-inline]]` and [[real]] link.\n"
    );
    const out = await lint(client);
    expect(out.total_wikilinks).toBe(1);
    expect(out.broken_count).toBe(0);
  });

  it("text_output_includes_broken_targets", async () => {
    await writeNote(vault, "note.md", "Broken: [[missing-thing]].\n");
    const res = await client.callTool({
      name: "lint_links",
      arguments: {},
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    expect(text).toContain("[[missing-thing]]");
    expect(text).toContain("note.md:1");
  });
});

describe("lint_links — attachment wikilinks", () => {
  let vault: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ vault, client, close } = await setupVault());
  });

  afterEach(async () => {
    await close();
  });

  it("attachment_link_existing_file_path_form", async () => {
    await writeAttachment(vault, "_attachments/doc.pdf");
    await writeNote(vault, "note.md", "See [[_attachments/doc.pdf]] for details.\n");
    const out = await lint(client);
    expect(out.total_wikilinks).toBe(1);
    expect(out.broken_count).toBe(0);
  });

  it("attachment_link_existing_file_basename_form", async () => {
    await writeAttachment(vault, "_attachments/image.png");
    await writeNote(vault, "note.md", "Embed: [[image.png]] here.\n");
    const out = await lint(client);
    expect(out.total_wikilinks).toBe(1);
    expect(out.broken_count).toBe(0);
  });

  it("attachment_link_missing_file", async () => {
    await writeNote(vault, "note.md", "Missing: [[_attachments/ghost.pdf]].\n");
    const out = await lint(client);
    expect(out.broken_count).toBe(1);
    const broken = out.broken_links[0]!;
    expect(broken.target).toBe("_attachments/ghost.pdf");
    expect(broken.classification).toBe("attachment_missing");
    expect(broken.suggested_fix.action).toBe("no_clear_match");
    expect(broken.suggested_fix.confidence).toBe("low");
    expect(broken.candidates).toEqual([]);
    expect(out.summary.by_classification.attachment_missing).toBe(1);
  });

  it("mixed_attachment_and_note_links", async () => {
    await writeAttachment(vault, "_attachments/real.pdf");
    await writeNote(vault, "real-note.md", "Real.\n");
    await writeNote(
      vault,
      "index.md",
      [
        "PDF: [[_attachments/real.pdf]]",
        "Note: [[real-note]]",
        "Missing PDF: [[_attachments/ghost.pdf]]",
        "Missing note: [[ghost-note]]",
        "",
      ].join("\n")
    );
    const out = await lint(client);
    expect(out.total_wikilinks).toBe(4);
    expect(out.broken_count).toBe(2);
    expect(out.summary.by_classification.attachment_missing).toBe(1);
    expect(out.summary.by_classification.phantom).toBe(1);
    expect(out.summary.by_classification.title_form).toBe(0);
    expect(out.summary.by_classification.typo).toBe(0);

    const byTarget = new Map(out.broken_links.map((b) => [b.target, b]));
    expect(byTarget.get("_attachments/ghost.pdf")?.classification).toBe(
      "attachment_missing"
    );
    expect(byTarget.get("ghost-note")?.classification).toBe("phantom");
  });

  it("non_attachment_extension_treated_as_note", async () => {
    await writeNote(vault, "note.md", "Weird: [[foo.bar]] link.\n");
    const out = await lint(client);
    expect(out.broken_count).toBe(1);
    const broken = out.broken_links[0]!;
    expect(broken.classification).toBe("phantom");
    expect(out.summary.by_classification.attachment_missing).toBe(0);
    expect(out.summary.by_classification.phantom).toBe(1);
  });

  it("text_output_marks_attachment_missing", async () => {
    await writeNote(vault, "note.md", "Missing: [[_attachments/ghost.pdf]].\n");
    const res = await client.callTool({
      name: "lint_links",
      arguments: {},
    });
    const content = res.content as Array<{ type: string; text: string }>;
    const text = content[0]!.text;
    expect(text).toContain("[[_attachments/ghost.pdf]] [attachment]");
    expect(text).toContain("(attachment_missing)");
  });
});
