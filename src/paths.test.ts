import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeVaultPath,
  resolveVaultPath,
  listTopLevelFolders,
  assertKnownTopLevelFolder,
} from "./paths.js";

describe("normalizeVaultPath", () => {
  it("returns relative paths unchanged when already normalized", () => {
    expect(normalizeVaultPath("public/tech/note.md")).toBe("public/tech/note.md");
  });

  it("collapses . segments and trailing slash", () => {
    expect(normalizeVaultPath("./foo/./bar/")).toBe("foo/bar");
  });

  it("collapses internal .. segments", () => {
    expect(normalizeVaultPath("foo/bar/../baz")).toBe("foo/baz");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(normalizeVaultPath("foo\\bar\\baz.md")).toBe("foo/bar/baz.md");
  });

  it("rejects absolute posix paths", () => {
    expect(() => normalizeVaultPath("/etc/passwd")).toThrow(/absolute/);
  });

  it("rejects absolute Windows paths", () => {
    expect(() => normalizeVaultPath("C:\\foo")).toThrow(/absolute/);
  });

  it("rejects UNC-style Windows paths", () => {
    expect(() => normalizeVaultPath("\\\\server\\share\\foo")).toThrow(/absolute/);
  });

  it("rejects paths that escape vault root", () => {
    expect(() => normalizeVaultPath("foo/../../etc")).toThrow("Path traversal detected");
  });

  it("rejects exactly ..", () => {
    expect(() => normalizeVaultPath("..")).toThrow("Path traversal detected");
  });

  it("rejects empty string", () => {
    expect(() => normalizeVaultPath("")).toThrow("Path is empty");
  });

  it("rejects whitespace-only strings", () => {
    expect(() => normalizeVaultPath("   ")).toThrow("Path is empty");
  });

  it("preserves vault root marker", () => {
    expect(normalizeVaultPath(".")).toBe(".");
  });
});

describe("resolveVaultPath", () => {
  it("resolves a relative path", () => {
    expect(resolveVaultPath("/vault", "public/note.md")).toBe("/vault/public/note.md");
  });

  it("throws on path traversal", () => {
    expect(() => resolveVaultPath("/vault", "../etc/passwd")).toThrow(
      "Path traversal detected"
    );
  });

  it("normalizes . and .. before joining", () => {
    expect(resolveVaultPath("/vault", "./foo/../public/note.md")).toBe(
      "/vault/public/note.md"
    );
  });

  it("normalizes backslashes", () => {
    expect(resolveVaultPath("/vault", "public\\tech\\note.md")).toBe(
      "/vault/public/tech/note.md"
    );
  });
});

describe("listTopLevelFolders", () => {
  it("lists real top-level directories, excluding .obsidian", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "archai-paths-test-"));
    try {
      await mkdir(join(vaultPath, "concepts"));
      await mkdir(join(vaultPath, "patterns"));
      await mkdir(join(vaultPath, ".obsidian"));
      expect(await listTopLevelFolders(vaultPath)).toEqual(["concepts", "patterns"]);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("returns an empty array for a flat vault", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "archai-paths-test-"));
    try {
      expect(await listTopLevelFolders(vaultPath)).toEqual([]);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("returns an empty array when the vault root doesn't exist", async () => {
    expect(await listTopLevelFolders("/nonexistent/archai-vault")).toEqual([]);
  });
});

describe("assertKnownTopLevelFolder", () => {
  it("allows the vault root", async () => {
    await expect(
      assertKnownTopLevelFolder("/nonexistent", "test", ".")
    ).resolves.toBeUndefined();
  });

  it("allows a path under an existing top-level folder", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "archai-paths-test-"));
    try {
      await mkdir(join(vaultPath, "concepts"));
      await expect(
        assertKnownTopLevelFolder(vaultPath, "test", "concepts/react")
      ).resolves.toBeUndefined();
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("rejects an unknown top-level folder and lists the valid ones", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "archai-paths-test-"));
    try {
      await mkdir(join(vaultPath, "concepts"));
      await expect(
        assertKnownTopLevelFolder(vaultPath, "tech", "public/tech")
      ).rejects.toThrow(/Unknown top-level folder "public" in vault "tech"/);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });

  it("rejects with a flat-vault message when there are no top-level folders", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "archai-paths-test-"));
    try {
      await expect(
        assertKnownTopLevelFolder(vaultPath, "work", "notes")
      ).rejects.toThrow(/no subfolders yet/);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });
});
