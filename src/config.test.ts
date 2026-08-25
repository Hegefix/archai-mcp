import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { createServer, loadVaultConfig, partitionAvailableVaults, resolveVault } from "./index.js";

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

async function connect(input: unknown): Promise<Client> {
  const server = await createServer(input as string);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("vaults.json log option", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archai-config-"));
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(config: unknown): Promise<string> {
    const path = join(dir, "vaults.json");
    await writeFile(path, JSON.stringify(config), "utf-8");
    return path;
  }

  it("accepts a bare path string, with logging off", async () => {
    const registry = await loadVaultConfig(await write({ vaults: { a: "./a" } }));
    expect(registry.vaults.get("a")).toBe(join(dir, "a"));
    expect(registry.logEnabled?.has("a")).toBe(false);
  });

  it("accepts the object form and reads log: true", async () => {
    const registry = await loadVaultConfig(
      await write({ vaults: { a: { path: "./a", log: true }, b: "./b" } })
    );
    expect(registry.vaults.get("a")).toBe(join(dir, "a"));
    expect(registry.logEnabled?.has("a")).toBe(true);
    expect(registry.logEnabled?.has("b")).toBe(false);
  });

  it("treats log: false the same as omitting it", async () => {
    const registry = await loadVaultConfig(
      await write({ vaults: { a: { path: "./a", log: false } } })
    );
    expect(registry.logEnabled?.has("a")).toBe(false);
  });

  it("rejects a non-boolean log option", async () => {
    await expect(
      loadVaultConfig(await write({ vaults: { a: { path: "./a", log: "yes" } } }))
    ).rejects.toThrow('option "log" must be a boolean');
  });

  it("rejects an object entry with no path", async () => {
    await expect(
      loadVaultConfig(await write({ vaults: { a: { log: true } } }))
    ).rejects.toThrow("must have a non-empty path");
  });
});

describe("vaults absent from this machine", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archai-sparse-"));
    await mkdir(join(dir, "tech"), { recursive: true });
    await mkdir(join(dir, "work"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Mirrors a sparse checkout: psychology is configured but never materialized. */
  const sparseRegistry = () => ({
    vaults: new Map([
      ["tech", join(dir, "tech")],
      ["work", join(dir, "work")],
      ["psychology", join(dir, "psychology")],
    ]),
    defaultName: "tech",
  });

  it("keeps the present vaults and records the absent one", async () => {
    const { registry, warnings } = await partitionAvailableVaults(sparseRegistry());
    expect([...registry.vaults.keys()]).toEqual(["tech", "work"]);
    expect(registry.missing?.get("psychology")).toBe(join(dir, "psychology"));
    expect(warnings).toEqual([
      `vault "psychology" skipped: no directory at ${join(dir, "psychology")}`,
    ]);
  });

  it("does not treat a file as a vault directory", async () => {
    await writeFile(join(dir, "notadir"), "x", "utf-8");
    const { registry } = await partitionAvailableVaults({
      vaults: new Map([
        ["tech", join(dir, "tech")],
        ["notadir", join(dir, "notadir")],
      ]),
      defaultName: "tech",
    });
    expect([...registry.vaults.keys()]).toEqual(["tech"]);
  });

  it("falls back to a present vault when the default is absent", async () => {
    const { registry, warnings } = await partitionAvailableVaults({
      vaults: new Map([
        ["psychology", join(dir, "psychology")],
        ["tech", join(dir, "tech")],
      ]),
      defaultName: "psychology",
    });
    expect(registry.defaultName).toBe("tech");
    expect(warnings.join(" ")).toContain("falling back");
  });

  it("preserves the log opt-in through partitioning", async () => {
    const { registry } = await partitionAvailableVaults({
      ...sparseRegistry(),
      logEnabled: new Set(["work"]),
    });
    expect(registry.logEnabled?.has("work")).toBe(true);
  });

  // Serving nothing is a real misconfiguration; serving two of six is Tuesday.
  it("fails only when nothing at all is present", async () => {
    await expect(
      partitionAvailableVaults({
        vaults: new Map([["psychology", join(dir, "psychology")]]),
        defaultName: "psychology",
      })
    ).rejects.toThrow("None of the configured vaults exist on this machine");
  });

  it("tells a caller naming an absent vault that it was skipped, not that it is unknown", async () => {
    const { registry } = await partitionAvailableVaults(sparseRegistry());
    expect(() => resolveVault(registry, "psychology")).toThrow(
      /configured but its directory is missing/
    );
    expect(() => resolveVault(registry, "psychology")).toThrow(/sparse-checkout/);
    expect(() => resolveVault(registry, "nonsense")).toThrow(/not found/);
  });

  describe("over a live server", () => {
    let client: Client;

    beforeEach(async () => {
      await writeFile(join(dir, "tech", "a.md"), "see [[a]]\n", "utf-8");
      client = await connect(sparseRegistry());
    });

    afterEach(async () => {
      await client.close();
    });

    it("starts up and serves the vaults that do exist", async () => {
      const data = structured(await client.callTool({ name: "list_vaults", arguments: {} }));
      expect(data["vaults"].map((v: any) => v.name)).toEqual(["tech", "work"]);
    });

    // "The tool says six vaults, the disk has two" is the drift being prevented.
    it("reports the absent vault as skipped rather than listing it as a vault", async () => {
      const result = await client.callTool({ name: "list_vaults", arguments: {} });
      expect(structured(result)["skipped"]).toEqual([
        { name: "psychology", path: join(dir, "psychology") },
      ]);
      expect(getText(result)).toContain("Configured but not present");
    });

    it("does not let lint_links pass off an unread vault as clean", async () => {
      const summary = structured(
        await client.callTool({ name: "lint_links", arguments: {} })
      )["summary"];
      expect(summary["vaults"]).toEqual(["tech", "work"]);
      expect(summary["skipped"]).toEqual(["psychology"]);
    });

    it("names the skipped vault in lint_links' text summary", async () => {
      const text = getText(await client.callTool({ name: "lint_links", arguments: {} }));
      expect(text).toContain("skipped=psychology");
    });

    it("refuses to lint an absent vault instead of reporting it healthy", async () => {
      const result = await client.callTool({
        name: "lint_links",
        arguments: { vault: "psychology" },
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("missing");
    });

    it("refuses a write to an absent vault", async () => {
      const result = await client.callTool({
        name: "save",
        arguments: { title: "Nope", content: "x", vault: "psychology", force: true },
      });
      expect(result.isError).toBe(true);
      expect(getText(result)).toContain("psychology");
    });
  });
});

describe("commit pathspec", () => {
  let repoRoot: string;
  let client: Client;

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), "archai-pathspec-"));
    await mkdir(join(repoRoot, "tech/concepts"), { recursive: true });
    await mkdir(join(repoRoot, "work"), { recursive: true });
    await git(repoRoot, ["init"]);
    await git(repoRoot, ["config", "user.email", "test@example.com"]);
    await git(repoRoot, ["config", "user.name", "archai test"]);

    await writeFile(join(repoRoot, "tech/unrelated.md"), "original\n", "utf-8");
    await writeFile(join(repoRoot, "work/sibling.md"), "original\n", "utf-8");
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

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  it("commits only the file the tool wrote, not other edits in the same vault", async () => {
    // An in-progress edit, as if made in Obsidian since the last write.
    await writeFile(join(repoRoot, "tech/unrelated.md"), "edited in obsidian\n", "utf-8");

    await call("save", {
      title: "Test Note",
      content: "body",
      folder: "concepts",
      force: true,
    });

    expect(await git(repoRoot, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      "tech/concepts/test-note.md"
    );
    // Still pending: the commit's contents match its message and nothing else.
    expect(await git(repoRoot, ["status", "--porcelain"])).toBe("M tech/unrelated.md");
  });

  it("leaves a sibling vault's edits out of the commit", async () => {
    await writeFile(join(repoRoot, "work/sibling.md"), "edited\n", "utf-8");
    await call("save", { title: "Test Note", content: "body", force: true });

    expect(await git(repoRoot, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      "tech/test-note.md"
    );
    expect(await git(repoRoot, ["status", "--porcelain"])).toBe("M work/sibling.md");
  });

  it("commits both ends of a move plus the notes whose links changed, and nothing else", async () => {
    await writeFile(join(repoRoot, "tech/concepts/target.md"), "target\n", "utf-8");
    await writeFile(join(repoRoot, "tech/citer.md"), "see [[target]]\n", "utf-8");
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "notes"]);

    await writeFile(join(repoRoot, "tech/unrelated.md"), "edited in obsidian\n", "utf-8");

    const result = await call("move", {
      from: "concepts/target.md",
      to: "concepts/renamed.md",
    });
    expect(result.isError).toBeFalsy();

    // --no-renames so the rename is listed as both of its paths; with rename
    // detection on, --name-only collapses it to the destination alone.
    const committed = (
      await git(repoRoot, ["show", "--name-only", "--format=", "--no-renames", "HEAD"])
    ).split("\n");
    expect(committed.sort()).toEqual(
      ["tech/citer.md", "tech/concepts/renamed.md", "tech/concepts/target.md"].sort()
    );
    expect(await git(repoRoot, ["status", "--porcelain"])).toBe("M tech/unrelated.md");
  });

  it("still records a move as a rename despite the explicit pathspec", async () => {
    await writeFile(join(repoRoot, "tech/concepts/target.md"), "target\n", "utf-8");
    await git(repoRoot, ["add", "-A"]);
    await git(repoRoot, ["commit", "-m", "note"]);

    await call("move", { from: "concepts/target.md", to: "concepts/renamed.md" });

    const status = await git(repoRoot, [
      "show",
      "--name-status",
      "--format=",
      "--find-renames",
      "HEAD",
    ]);
    expect(status).toMatch(/^R/m);
  });
});

describe("status and stale_when over a live server", () => {
  let vaultPath: string;
  let client: Client;

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), "archai-status-"));
    await mkdir(join(vaultPath, "notes"), { recursive: true });
    client = await connect(vaultPath);
  });

  afterEach(async () => {
    await client.close();
    await rm(vaultPath, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });

  const front = async (relative: string) =>
    matter(await readFile(join(vaultPath, relative), "utf-8")).data;

  it("defaults a saved note to draft", async () => {
    await call("save", { title: "A Note", content: "body", force: true });
    expect((await front("a-note.md"))["status"]).toBe("draft");
  });

  it("saves a verified note when a date is given", async () => {
    await call("save", {
      title: "Verified Note",
      content: "body",
      status: "verified",
      verified: "2026-08-25",
      force: true,
    });
    const data = await front("verified-note.md");
    expect(data["status"]).toBe("verified");
    expect(data["verified"]).toBe("2026-08-25");
  });

  it("refuses to save verified with no date", async () => {
    const result = await call("save", {
      title: "Bad Note",
      content: "body",
      status: "verified",
      force: true,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("requires a verified");
  });

  it("refuses a date without the verified status", async () => {
    const result = await call("save", {
      title: "Bad Note",
      content: "body",
      verified: "2026-08-25",
      force: true,
    });
    expect(result.isError).toBe(true);
  });

  it("rejects a retired status value from an old client, naming the replacement", async () => {
    const result = await call("save", {
      title: "Old Client Note",
      content: "body",
      status: "seedling",
      force: true,
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("seedling");
    expect(getText(result)).toContain("draft | verified");
  });

  it("stores stale_when when given, and omits it when not", async () => {
    await call("save", {
      title: "Expiring Note",
      content: "body",
      stale_when: "prod moves past v1.63.0+2053",
      force: true,
    });
    expect((await front("expiring-note.md"))["stale_when"]).toBe(
      "prod moves past v1.63.0+2053"
    );

    await call("save", { title: "Plain Note", content: "body", force: true });
    expect((await front("plain-note.md"))["stale_when"]).toBeUndefined();
  });

  it("preserves stale_when through an update that does not mention it", async () => {
    await call("save", {
      title: "Expiring Note",
      content: "body",
      stale_when: "prod moves past v1.63.0+2053",
      force: true,
    });
    await call("update", { path: "expiring-note.md", content: "new body" });
    expect((await front("expiring-note.md"))["stale_when"]).toBe(
      "prod moves past v1.63.0+2053"
    );
  });

  it("replaces stale_when when a new condition is given, and clears it on empty", async () => {
    await call("save", {
      title: "Expiring Note",
      content: "body",
      stale_when: "old condition",
      force: true,
    });
    await call("update", {
      path: "expiring-note.md",
      content: "b",
      stale_when: "new condition",
    });
    expect((await front("expiring-note.md"))["stale_when"]).toBe("new condition");

    await call("update", { path: "expiring-note.md", content: "c", stale_when: "" });
    expect((await front("expiring-note.md"))["stale_when"]).toBeUndefined();
  });

  it("promotes a note to verified through update", async () => {
    await call("save", { title: "A Note", content: "body", force: true });
    await call("update", {
      path: "a-note.md",
      content: "checked",
      status: "verified",
      verified: "2026-08-25",
    });
    const data = await front("a-note.md");
    expect(data["status"]).toBe("verified");
    expect(data["verified"]).toBe("2026-08-25");
  });

  it("drops the verified date when demoting to draft, and says so", async () => {
    await call("save", {
      title: "A Note",
      content: "body",
      status: "verified",
      verified: "2026-08-25",
      force: true,
    });
    const result = await call("update", {
      path: "a-note.md",
      content: "reopened",
      status: "draft",
    });
    expect((await front("a-note.md"))["verified"]).toBeUndefined();
    expect(getText(result)).toContain("dropped the verified date");
  });

  it("keeps status and verified untouched on an update that does not mention them", async () => {
    await call("save", {
      title: "A Note",
      content: "body",
      status: "verified",
      verified: "2026-08-07",
      force: true,
    });
    await call("update", { path: "a-note.md", content: "new body" });
    const data = await front("a-note.md");
    expect(data["status"]).toBe("verified");
    expect(data["verified"]).toBe("2026-08-07");
  });

  it("migrates a stored retired status to draft on update", async () => {
    await writeFile(
      join(vaultPath, "notes/legacy.md"),
      "---\ntitle: Legacy\nstatus: seedling\n---\nbody\n",
      "utf-8"
    );
    const result = await call("update", { path: "notes/legacy.md", content: "new body" });
    expect((await front("notes/legacy.md"))["status"]).toBe("draft");
    expect(getText(result)).toContain("retired scale");
  });
});
