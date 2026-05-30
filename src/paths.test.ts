import { describe, it, expect } from "vitest";
import {
  normalizeVaultPath,
  resolveVaultPath,
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
