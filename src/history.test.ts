import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { createServer, commitVault, findRepoRoot, referencePath } from "./index.js";

const run = promisify(execFile);
const TODAY = new Date().toISOString().split("T")[0] as string;

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content as Array<{ type: string; text: string }>;
  return block[0]?.text ?? "";
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

/** A repo with a local identity, so commits work regardless of global git config. */
async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "archai test"]);
}

async function connect(input: unknown): Promise<Client> {
  const server = await createServer(input as string);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

// --- Unit tests ---

describe("referencePath", () => {
  it("places a path under references/", () => {
    expect(referencePath("rfc/rfc-9110.txt")).toBe("references/rfc/rfc-9110.txt");
  });

  it("rejects a path that climbs out of references/", () => {
    expect(() => referencePath("../notes/leak.md")).toThrow("Path traversal detected");
    expect(() => referencePath("sub/../../leak.md")).toThrow("Path traversal detected");
  });

  it("rejects a path that resolves to the references folder itself", () => {
    expect(() => referencePath(".")).toThrow("must name a file inside references/");
  });

  it("rejects an absolute path", () => {
    expect(() => referencePath("/etc/passwd")).toThrow("must be relative to vault root");
  });
});

describe("commitVault", () => {
  it("warns instead of throwing when the vault path is unusable", async () => {
    const warning = await commitVault(join(tmpdir(), "archai-does-not-exist"), "save: x.md");
    expect(warning).toContain("git commit skipped");
  });
});

// --- Integration tests ---

describe("write hooks", () => {
  let vaultPath: string;
  let client: Client;

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "archai-history-"));
    await mkdir(join(vaultPath, "concepts"), { recursive: true });
    await initRepo(vaultPath);
    await git(vaultPath, ["commit", "--allow-empty", "-m", "base"]);
    client = await connect(vaultPath);
  });

  afterEach(async () => {
    await client.close();
    await rm(vaultPath, { recursive: true, force: true });
  });

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: args });
  }

  async function log(): Promise<string> {
    return readFile(join(vaultPath, "log.md"), "utf-8");
  }

  describe("git history", () => {
    it("commits a saved note, naming the tool and path", async () => {
      await callTool("save", {
        title: "Test Note",
        content: "body",
        folder: "concepts",
        force: true,
      });
      expect(await git(vaultPath, ["log", "--format=%s", "-1"])).toBe(
        "save: concepts/test-note.md"
      );
      expect(await git(vaultPath, ["status", "--porcelain"])).toBe("");
    });

    it("commits an update and a reference under their own tool names", async () => {
      await callTool("save", { title: "Test Note", content: "body", force: true });
      await callTool("update", { path: "test-note.md", content: "new body" });
      await callTool("save_reference", { path: "rfc/spec.txt", content: "RAW" });

      const subjects = await git(vaultPath, ["log", "--format=%s", "-3"]);
      expect(subjects.split("\n")).toEqual([
        "save_reference: references/rfc/spec.txt",
        "update: test-note.md",
        "save: test-note.md",
      ]);
    });

    it("keeps the note and its log entry in one commit", async () => {
      await callTool("save", { title: "Test Note", content: "body", force: true });
      const files = await git(vaultPath, ["show", "--name-only", "--format=", "HEAD"]);
      expect(files.split("\n").sort()).toEqual(["log.md", "test-note.md"]);
    });

    it("initializes a repo when the vault has none", async () => {
      const fresh = await mkdtemp(join(tmpdir(), "archai-noinit-"));
      const freshClient = await connect(fresh);
      try {
        await freshClient.callTool({
          name: "save",
          arguments: { title: "First", content: "x", force: true },
        });
        expect(await findRepoRoot(fresh)).toBe(await git(fresh, ["rev-parse", "--show-toplevel"]));
        expect((await stat(join(fresh, ".git"))).isDirectory()).toBe(true);
      } finally {
        await freshClient.close();
        await rm(fresh, { recursive: true, force: true });
      }
    });

    it("does not commit anything for read-only tools", async () => {
      const before = await git(vaultPath, ["rev-parse", "HEAD"]);
      await callTool("list", {});
      await callTool("search", { query: "anything" });
      await callTool("list_vaults", {});
      await callTool("create_folder", { path: "concepts/nested" });
      expect(await git(vaultPath, ["rev-parse", "HEAD"])).toBe(before);
    });
  });

  describe("log.md", () => {
    it("records creations, updates and references under today's heading", async () => {
      await callTool("save", {
        title: "Test Note",
        content: "body",
        folder: "concepts",
        force: true,
      });
      await callTool("update", { path: "concepts/test-note.md", content: "new body" });
      await callTool("save_reference", { path: "rfc/spec.txt", content: "RAW" });

      const contents = await log();
      expect(contents).toContain(`## ${TODAY}`);
      expect(contents).toContain("* **Creation**: [[concepts/test-note]] — Test Note");
      expect(contents).toContain("* **Update**: [[concepts/test-note]] — Test Note");
      expect(contents).toContain("* **Reference**: references/rfc/spec.txt");
      expect(contents.match(new RegExp(`## ${TODAY}`, "g"))).toHaveLength(1);
    });

    it("appends to a log that already exists", async () => {
      await writeFile(
        join(vaultPath, "log.md"),
        "# Log\n\n## 2020-01-01\n\n* **Creation**: [[old]]\n",
        "utf-8"
      );
      await callTool("save", { title: "Test Note", content: "body", force: true });

      const contents = await log();
      expect(contents).toContain("## 2020-01-01");
      expect(contents).toContain("* **Creation**: [[old]]");
      expect(contents).toContain(`## ${TODAY}`);
    });

    it("lives at the vault root, one per vault", async () => {
      await callTool("save", {
        title: "Test Note",
        content: "body",
        folder: "concepts",
        force: true,
      });
      await expect(stat(join(vaultPath, "concepts/log.md"))).rejects.toThrow();
      expect((await stat(join(vaultPath, "log.md"))).isFile()).toBe(true);
    });
  });

  describe("save_reference", () => {
    it("writes raw content verbatim, with no frontmatter", async () => {
      const raw = "---\nnot: frontmatter\n---\n\nliteral body\n";
      const result = await callTool("save_reference", { path: "rfc/spec.txt", content: raw });
      expect(getText(result)).toContain("Stored: [default] references/rfc/spec.txt");
      expect(await readFile(join(vaultPath, "references/rfc/spec.txt"), "utf-8")).toBe(raw);
    });

    it("creates references/ without allowNewTopLevel", async () => {
      const result = await callTool("save_reference", { path: "a.txt", content: "x" });
      expect(result.isError).toBeFalsy();
      expect((await stat(join(vaultPath, "references"))).isDirectory()).toBe(true);
    });

    it("refuses to overwrite an existing reference", async () => {
      await callTool("save_reference", { path: "a.txt", content: "first" });
      const result = await callTool("save_reference", { path: "a.txt", content: "second" });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("References are immutable");
      expect(await readFile(join(vaultPath, "references/a.txt"), "utf-8")).toBe("first");
    });

    it("rejects a path escaping references/", async () => {
      const result = await callTool("save_reference", {
        path: "../concepts/leak.md",
        content: "x",
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("Path traversal detected");
    });

    it("skips the duplicate check that save applies to titled notes", async () => {
      await callTool("save", {
        title: "React Hooks",
        content: "body",
        folder: "concepts",
        force: true,
      });
      // save would return matches here; save_reference stores raw material regardless.
      const result = await callTool("save_reference", {
        path: "react-hooks.txt",
        content: "raw dump about react hooks",
      });
      expect(result.isError).toBeFalsy();
      expect(getText(result)).toContain("Stored:");
    });

    it("has no companion update_reference tool", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("save_reference");
      expect(names).not.toContain("update_reference");
    });
  });

  describe("sources frontmatter", () => {
    it("records sources on save alongside the generated fields", async () => {
      await callTool("save", {
        title: "Test Note",
        content: "body",
        force: true,
        tags: ["ts"],
        sources: [
          {
            resource: "https://example.com/a",
            id: "a1",
            title: "Example A",
            author: "vk",
            last_modified: "2026-08-01",
          },
        ],
      });
      const parsed = matter(await readFile(join(vaultPath, "test-note.md"), "utf-8"));
      expect(parsed.data["title"]).toBe("Test Note");
      expect(parsed.data["status"]).toBe("seedling");
      expect(parsed.data["tags"]).toEqual(["ts"]);
      expect(parsed.data["sources"]).toEqual([
        {
          resource: "https://example.com/a",
          id: "a1",
          title: "Example A",
          author: "vk",
          last_modified: "2026-08-01",
        },
      ]);
    });

    it("merges new sources into the existing list on update", async () => {
      await callTool("save", {
        title: "Test Note",
        content: "body",
        force: true,
        sources: [{ resource: "slack", id: "C1", title: "Old" }],
      });
      await callTool("update", {
        path: "test-note.md",
        content: "new body",
        sources: [
          { resource: "slack", id: "C1", last_modified: "2026-08-17" },
          { resource: "jira", id: "ABC-1" },
        ],
      });
      const parsed = matter(await readFile(join(vaultPath, "test-note.md"), "utf-8"));
      expect(parsed.data["sources"]).toEqual([
        { resource: "slack", id: "C1", title: "Old", last_modified: "2026-08-17" },
        { resource: "jira", id: "ABC-1" },
      ]);
    });

    it("leaves existing sources alone when update passes none", async () => {
      await callTool("save", {
        title: "Test Note",
        content: "body",
        force: true,
        sources: [{ resource: "slack", id: "C1" }],
      });
      await callTool("update", { path: "test-note.md", content: "new body" });
      const parsed = matter(await readFile(join(vaultPath, "test-note.md"), "utf-8"));
      expect(parsed.data["sources"]).toEqual([{ resource: "slack", id: "C1" }]);
      expect(parsed.data["updated"]).toBe(TODAY);
    });
  });
});

describe("vault inside an enclosing repo", () => {
  let repoRoot: string;
  let client: Client;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "archai-monorepo-"));
    await mkdir(join(repoRoot, "tech/concepts"), { recursive: true });
    await mkdir(join(repoRoot, "work"), { recursive: true });
    await initRepo(repoRoot);
    await writeFile(join(repoRoot, "work/existing.md"), "tracked\n", "utf-8");
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "base"]);

    client = await connect({
      vaults: new Map([
        ["tech", join(repoRoot, "tech")],
        ["work", join(repoRoot, "work")],
      ]),
      defaultName: "tech",
    });
  });

  afterEach(async () => {
    await client.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("reuses the enclosing repo instead of nesting a new one", async () => {
    await client.callTool({
      name: "save",
      arguments: { title: "Test Note", content: "body", folder: "concepts", force: true },
    });
    await expect(stat(join(repoRoot, "tech/.git"))).rejects.toThrow();
    expect(await git(repoRoot, ["log", "--format=%s", "-1"])).toBe(
      "save: concepts/test-note.md"
    );
  });

  it("scopes the commit to the written vault, leaving the other vault dirty", async () => {
    await writeFile(join(repoRoot, "work/existing.md"), "edited outside the server\n", "utf-8");
    await client.callTool({
      name: "save",
      arguments: { title: "Test Note", content: "body", folder: "concepts", force: true },
    });

    const committed = await git(repoRoot, ["show", "--name-only", "--format=", "HEAD"]);
    expect(committed.split("\n").sort()).toEqual(["tech/log.md", "tech/concepts/test-note.md"].sort());
    // Still dirty: the pathspec kept the other vault's edit out of the commit.
    expect(await git(repoRoot, ["status", "--porcelain"])).toBe("M work/existing.md");
  });

  it("gives each vault its own log.md", async () => {
    await client.callTool({
      name: "save",
      arguments: { title: "Tech Note", content: "body", folder: "concepts", force: true },
    });
    await client.callTool({
      name: "save",
      arguments: { title: "Work Note", content: "body", vault: "work", force: true },
    });
    expect(await readFile(join(repoRoot, "tech/log.md"), "utf-8")).toContain("[[concepts/tech-note]]");
    expect(await readFile(join(repoRoot, "work/log.md"), "utf-8")).toContain("[[work-note]]");
  });
});
