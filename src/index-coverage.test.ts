import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import {
  createServer,
  buildVaultIndex,
  indexCoverage,
  isIndexed,
  findUnindexed,
  linksUp,
  UP_FIELD,
  UP_LINK,
} from "./index.js";

const run = promisify(execFile);

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content as Array<{ type: string; text: string }>;
  return block[0]?.text ?? "";
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, any> {
  return (result.structuredContent ?? {}) as Record<string, any>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

// --- Pure unit tests ---

describe("index coverage", () => {
  const index = buildVaultIndex("v", [
    "index.md",
    "log.md",
    "concepts/target.md",
    "notes/other.md",
    "notes/aliased.md",
    "notes/anchored.md",
    "notes/in-code.md",
  ]);

  const coverage = indexCoverage(
    [
      "# Map",
      "- [[target]] — bare basename",
      "- [[notes/other]] — folder-prefixed",
      "- [[aliased|Some Label]]",
      "- [[anchored#Heading]]",
      "- `[[in-code]]` is documentation, not a link",
      "- [part1](references/rfc/part1.md) — markdown link",
      "- `references/raw/dump.yaml` — non-markdown, by path",
      "- [[wiki-ref]] — a wikilink cannot reach a reference",
      "- [spaced](references/my%20notes.md)",
    ].join("\n"),
    index
  );

  it("counts a note reached by any resolvable wikilink shape", () => {
    expect(isIndexed(coverage, "concepts/target.md")).toBe(true);
    expect(isIndexed(coverage, "notes/other.md")).toBe(true);
    expect(isIndexed(coverage, "notes/aliased.md")).toBe(true);
    expect(isIndexed(coverage, "notes/anchored.md")).toBe(true);
  });

  it("does not count a link inside code", () => {
    expect(isIndexed(coverage, "notes/in-code.md")).toBe(false);
  });

  it("counts a reference by its path, in a markdown link or in backticks", () => {
    expect(isIndexed(coverage, "references/rfc/part1.md")).toBe(true);
    expect(isIndexed(coverage, "references/raw/dump.yaml")).toBe(true);
    expect(isIndexed(coverage, "references/my notes.md")).toBe(true);
  });

  it("does not count a reference reached only by wikilink", () => {
    expect(isIndexed(coverage, "references/wiki-ref.md")).toBe(false);
  });

  it("lists the unreached files, never the index itself or the log", () => {
    expect(
      findUnindexed(
        [
          "index.md",
          "log.md",
          "notes/in-code.md",
          "concepts/target.md",
          "references/wiki-ref.md",
          "notes/new.md",
        ],
        coverage
      )
    ).toEqual(["notes/in-code.md", "notes/new.md", "references/wiki-ref.md"]);
  });
});

describe("linksUp", () => {
  const index = buildVaultIndex("v", ["index.md", "notes/other.md", "notes/sub/index-of-x.md"]);

  it("accepts a link to the root index note, in any link shape", () => {
    expect(linksUp({ up: "[[index]]" }, index)).toBe(true);
    expect(linksUp({ up: "[[index|Map]]" }, index)).toBe(true);
    expect(linksUp({ up: ["[[other]]", "[[index]]"] }, index)).toBe(true);
  });

  it("rejects a missing, foreign or unquoted value", () => {
    expect(linksUp({}, index)).toBe(false);
    expect(linksUp({ up: "[[other]]" }, index)).toBe(false);
    expect(linksUp({ up: "index" }, index)).toBe(false);
    // `up: [[index]]` without quotes is YAML for a nested list, not a link.
    expect(linksUp({ up: [["index"]] }, index)).toBe(false);
  });

  it("writes the value save puts in frontmatter", () => {
    expect(UP_FIELD).toBe("up");
    expect(linksUp({ [UP_FIELD]: UP_LINK }, index)).toBe(true);
  });
});

// --- Integration via the MCP client ---

describe("index coverage in tools", () => {
  let vaultPath: string;
  let client: Client;

  async function start(): Promise<void> {
    const server = await createServer(vaultPath);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  }

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "archai-coverage-"));
    await mkdir(join(vaultPath, "notes"), { recursive: true });
    await git(vaultPath, ["init"]);
    await git(vaultPath, ["config", "user.email", "test@example.com"]);
    await git(vaultPath, ["config", "user.name", "archai test"]);
    await writeFile(
      join(vaultPath, "notes/listed.md"),
      "---\ntitle: Listed\nup: '[[index]]'\n---\nalready on the map\n",
      "utf-8"
    );
    await writeFile(join(vaultPath, "index.md"), "# Map\n- [[listed]]\n", "utf-8");
  });

  afterEach(async () => {
    await client?.close();
    await rm(vaultPath, { recursive: true, force: true });
  });

  describe("save", () => {
    it("tells the caller to add a new note to index.md", async () => {
      await start();
      const result = await call("save", {
        title: "Fresh Note",
        content: "body",
        folder: "notes",
        force: true,
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("Created: [default] notes/fresh-note.md");
      expect(getText(result)).toContain("Not in index.md yet");
      expect(getText(result)).toContain("[[fresh-note]]");
      expect(structured(result)["indexed"]).toBe(false);
    });

    it("stays quiet when index.md already plans a link to the note", async () => {
      await writeFile(
        join(vaultPath, "index.md"),
        "# Map\n- [[listed]]\n- [[fresh-note]] <!-- intentional -->\n",
        "utf-8"
      );
      await start();
      const result = await call("save", {
        title: "Fresh Note",
        content: "body",
        folder: "notes",
        force: true,
      });
      expect(getText(result)).not.toContain("index.md");
      expect(structured(result)["indexed"]).toBe(true);
    });

    it("links the new note up to index.md in frontmatter", async () => {
      await start();
      await call("save", { title: "Fresh Note", content: "body", folder: "notes", force: true });
      const raw = await readFile(join(vaultPath, "notes/fresh-note.md"), "utf-8");
      expect(raw).toContain("up: '[[index]]'");
      expect(matter(raw).data["up"]).toBe("[[index]]");
      expect(matter(raw).content.trim()).toBe("body");
    });

    it("keeps the up link through an update", async () => {
      await start();
      await call("save", { title: "Fresh Note", content: "body", folder: "notes", force: true });
      await call("update", { path: "notes/fresh-note.md", content: "new body" });
      const raw = await readFile(join(vaultPath, "notes/fresh-note.md"), "utf-8");
      expect(matter(raw).data["up"]).toBe("[[index]]");
    });

    it("gives a note written outside save its up link on the next update", async () => {
      await start();
      await writeFile(join(vaultPath, "notes/legacy.md"), "---\ntitle: Legacy\n---\nold\n", "utf-8");
      await call("update", { path: "notes/legacy.md", content: "edited" });
      const raw = await readFile(join(vaultPath, "notes/legacy.md"), "utf-8");
      expect(matter(raw).data["up"]).toBe("[[index]]");
      expect(matter(raw).content.trim()).toBe("edited");
    });

    it("never overwrites an up the note already sets", async () => {
      await writeFile(
        join(vaultPath, "notes/child.md"),
        "---\ntitle: Child\nup: '[[listed]]'\n---\nx\n",
        "utf-8"
      );
      await start();
      await call("update", { path: "notes/child.md", content: "y" });
      const raw = await readFile(join(vaultPath, "notes/child.md"), "utf-8");
      expect(matter(raw).data["up"]).toBe("[[listed]]");
    });

    it("never adds an up link to index.md itself on update", async () => {
      await start();
      await call("update", { path: "index.md", content: "# Map\n- [[listed]]\n" });
      const raw = await readFile(join(vaultPath, "index.md"), "utf-8");
      expect(matter(raw).data).not.toHaveProperty("up");
    });

    it("adds no up link in a vault without index.md", async () => {
      await rm(join(vaultPath, "index.md"));
      await start();
      await call("save", { title: "Fresh Note", content: "body", folder: "notes", force: true });
      const raw = await readFile(join(vaultPath, "notes/fresh-note.md"), "utf-8");
      expect(matter(raw).data).not.toHaveProperty("up");
    });

    it("stays quiet in a vault without index.md", async () => {
      await rm(join(vaultPath, "index.md"));
      await start();
      const result = await call("save", {
        title: "Fresh Note",
        content: "body",
        folder: "notes",
        force: true,
      });
      expect(getText(result)).not.toContain("index.md");
      expect(structured(result)).not.toHaveProperty("indexed");
    });
  });

  describe("save_reference", () => {
    it("tells the caller to add the reference to index.md by path", async () => {
      await start();
      const result = await call("save_reference", { path: "rfc/spec.md", content: "RAW" });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("Not in index.md yet");
      expect(getText(result)).toContain("](references/rfc/spec.md)");
      expect(structured(result)["indexed"]).toBe(false);
    });
  });

  describe("lint_links", () => {
    it("reports a note index.md does not reach and marks the vault unhealthy", async () => {
      await writeFile(join(vaultPath, "notes/stray.md"), "no one lists me\n", "utf-8");
      await start();
      const result = await call("lint_links", {});
      const data = structured(result);
      expect(data["summary"]).toMatchObject({ failures: 0, unindexed: 1, healthy: false });
      expect(data["unindexed"]).toEqual([{ vault: "default", file: "notes/stray.md" }]);
      expect(getText(result)).toContain("unindexed (1)");
      expect(getText(result)).toContain("notes/stray.md");
    });

    it("covers every file under references/, markdown or not", async () => {
      await mkdir(join(vaultPath, "references/raw"), { recursive: true });
      await writeFile(join(vaultPath, "references/raw/dump.yaml"), "a: 1\n", "utf-8");
      await writeFile(join(vaultPath, "references/raw/listed.txt"), "raw\n", "utf-8");
      await writeFile(
        join(vaultPath, "index.md"),
        "# Map\n- [[listed]]\n- `references/raw/listed.txt`\n",
        "utf-8"
      );
      await start();
      const data = structured(await call("lint_links", {}));
      expect(data["unindexed"]).toEqual([{ vault: "default", file: "references/raw/dump.yaml" }]);
    });

    it("is healthy once index.md reaches every note and every note links up", async () => {
      await start();
      const summary = structured(await call("lint_links", {}))["summary"];
      expect(summary).toMatchObject({ unindexed: 0, missingUp: 0, healthy: true });
    });

    it("reports a note with no up link to index.md and marks the vault unhealthy", async () => {
      await writeFile(
        join(vaultPath, "notes/orphan.md"),
        "---\ntitle: Orphan\n---\nlisted, but no way back up\n",
        "utf-8"
      );
      await writeFile(
        join(vaultPath, "index.md"),
        "# Map\n- [[listed]]\n- [[orphan]]\n",
        "utf-8"
      );
      await start();
      const result = await call("lint_links", {});
      const data = structured(result);
      expect(data["summary"]).toMatchObject({ unindexed: 0, missingUp: 1, healthy: false });
      expect(data["missingUp"]).toEqual([{ vault: "default", file: "notes/orphan.md" }]);
      expect(getText(result)).toContain("missing-up (1)");
    });

    it("never asks index.md or a reference to link up", async () => {
      await mkdir(join(vaultPath, "references"), { recursive: true });
      await writeFile(join(vaultPath, "references/raw.md"), "RAW\n", "utf-8");
      await writeFile(
        join(vaultPath, "index.md"),
        "# Map\n- [[listed]]\n- [raw](references/raw.md)\n",
        "utf-8"
      );
      await start();
      const summary = structured(await call("lint_links", {}))["summary"];
      expect(summary).toMatchObject({ missingUp: 0, healthy: true });
    });

    it("skips both checks in a vault without index.md", async () => {
      await rm(join(vaultPath, "index.md"));
      await writeFile(join(vaultPath, "notes/stray.md"), "---\ntitle: Stray\n---\nx\n", "utf-8");
      await start();
      const summary = structured(await call("lint_links", {}))["summary"];
      expect(summary).toMatchObject({ unindexed: 0, missingUp: 0, healthy: true });
    });
  });
});
