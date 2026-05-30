import * as path from "node:path";
import { glob } from "glob";

export function normalizeVaultPath(input: string): string {
  if (typeof input !== "string") {
    throw new Error("Path must be a string");
  }
  if (input.trim() === "") {
    throw new Error("Path is empty");
  }
  const forward = input.replace(/\\/g, "/");
  if (path.posix.isAbsolute(forward) || path.win32.isAbsolute(forward)) {
    throw new Error(`Path must be relative to vault root, got absolute: ${input}`);
  }
  const normalized = path.posix.normalize(forward);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path traversal detected: ${input}`);
  }
  if (normalized !== "." && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export function resolveVaultPath(vaultPath: string, relativePath: string): string {
  const normalized = normalizeVaultPath(relativePath);
  const resolved = path.join(vaultPath, normalized);
  if (!resolved.startsWith(vaultPath)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

export function getAllMarkdownFiles(vaultPath: string): Promise<string[]> {
  return glob("**/*.md", {
    cwd: vaultPath,
    ignore: [".obsidian/**"],
    nodir: true,
    posix: true,
  });
}

