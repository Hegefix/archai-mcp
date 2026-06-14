import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { toRegistry, resolveVault, loadVaultConfig } from "./vaults.js";

describe("toRegistry", () => {
  it("wraps a bare path string as a single default vault", () => {
    const reg = toRegistry("/vault");
    expect(reg.defaultName).toBe("default");
    expect(reg.vaults.get("default")).toBe("/vault");
  });

  it("passes a registry through unchanged", () => {
    const reg = toRegistry("/x");
    expect(toRegistry(reg)).toBe(reg);
  });
});

describe("resolveVault", () => {
  const reg = {
    vaults: new Map([
      ["personal", "/a"],
      ["work", "/b"],
    ]),
    defaultName: "personal",
  };

  it("returns the default vault when no name is given", () => {
    expect(resolveVault(reg)).toBe("/a");
  });

  it("returns a named vault", () => {
    expect(resolveVault(reg, "work")).toBe("/b");
  });

  it("throws on an unknown vault and lists available names", () => {
    expect(() => resolveVault(reg, "nope")).toThrow(/personal, work/);
  });
});

describe("loadVaultConfig", () => {
  let dir: string;

  async function writeConfig(contents: string): Promise<string> {
    const configPath = join(dir, "vaults.json");
    await writeFile(configPath, contents, "utf-8");
    return configPath;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archai-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads vaults with an explicit default", async () => {
    const configPath = await writeConfig(
      JSON.stringify({
        default: "work",
        vaults: { personal: "/a", work: "/b" },
      })
    );
    const reg = await loadVaultConfig(configPath);
    expect(reg.defaultName).toBe("work");
    expect(reg.vaults.get("personal")).toBe("/a");
    expect(reg.vaults.get("work")).toBe("/b");
  });

  it("defaults to the first listed vault when no default is given", async () => {
    const configPath = await writeConfig(
      JSON.stringify({ vaults: { personal: "/a", work: "/b" } })
    );
    const reg = await loadVaultConfig(configPath);
    expect(reg.defaultName).toBe("personal");
  });

  it("resolves relative paths against the config file's directory", async () => {
    const configPath = await writeConfig(
      JSON.stringify({ vaults: { tech: "./tech", wh: "../sibling/wh" } })
    );
    const reg = await loadVaultConfig(configPath);
    expect(reg.vaults.get("tech")).toBe(join(dir, "tech"));
    expect(reg.vaults.get("wh")).toBe(join(dir, "..", "sibling", "wh"));
  });

  it("expands a leading ~ to the home directory", async () => {
    const configPath = await writeConfig(
      JSON.stringify({ vaults: { home: "~/notes" } })
    );
    const reg = await loadVaultConfig(configPath);
    expect(reg.vaults.get("home")).toBe(join(homedir(), "notes"));
  });

  it("keeps absolute paths as-is", async () => {
    const configPath = await writeConfig(
      JSON.stringify({ vaults: { abs: "/already/absolute" } })
    );
    const reg = await loadVaultConfig(configPath);
    expect(reg.vaults.get("abs")).toBe("/already/absolute");
  });

  it("throws when the file is missing", async () => {
    await expect(loadVaultConfig(join(dir, "nope.json"))).rejects.toThrow(
      /Cannot read/
    );
  });

  it("throws on invalid JSON", async () => {
    const configPath = await writeConfig("{ not json");
    await expect(loadVaultConfig(configPath)).rejects.toThrow(/Invalid JSON/);
  });

  it("throws when vaults is missing", async () => {
    const configPath = await writeConfig(JSON.stringify({ default: "x" }));
    await expect(loadVaultConfig(configPath)).rejects.toThrow(/"vaults"/);
  });

  it("throws when vaults is empty", async () => {
    const configPath = await writeConfig(JSON.stringify({ vaults: {} }));
    await expect(loadVaultConfig(configPath)).rejects.toThrow(/empty/);
  });

  it("throws when a vault path is empty", async () => {
    const configPath = await writeConfig(
      JSON.stringify({ vaults: { bad: "" } })
    );
    await expect(loadVaultConfig(configPath)).rejects.toThrow(/non-empty/);
  });

  it("throws when the default is not a listed vault", async () => {
    const configPath = await writeConfig(
      JSON.stringify({ default: "ghost", vaults: { real: "/a" } })
    );
    await expect(loadVaultConfig(configPath)).rejects.toThrow(/not listed/);
  });
});
