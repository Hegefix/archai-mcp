import * as path from "node:path";
import { readFile } from "node:fs/promises";
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
  const resolved = path.resolve(vaultPath, normalized);
  // A string prefix check would accept a sibling like "/vaults/tech-old" for
  // vault "/vaults/tech"; compare on segment boundaries instead.
  const rel = path.relative(path.resolve(vaultPath), resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}

export function relativeFromTo(fromFile: string, toFile: string): string {
  const fromDir = path.posix.dirname(normalizeVaultPath(fromFile));
  const toNorm = normalizeVaultPath(toFile);
  return path.posix.relative(fromDir, toNorm);
}

export function vaultBasename(rel: string): string {
  return path.posix.basename(normalizeVaultPath(rel), ".md");
}

export function getAllAttachmentFiles(
  vaultPath: string,
  extensions: readonly string[]
): Promise<string[]> {
  return glob(`**/*.{${extensions.join(",")}}`, {
    cwd: vaultPath,
    ignore: [".obsidian/**"],
    nodir: true,
    posix: true,
    nocase: true,
  });
}

export function getAllMarkdownFiles(vaultPath: string): Promise<string[]> {
  return glob("**/*.md", {
    cwd: vaultPath,
    ignore: [".obsidian/**"],
    nodir: true,
    posix: true,
  });
}

/**
 * Read a note, yielding null instead of throwing. Vault scans race with Obsidian
 * and git: a file listed by glob can be gone or unreadable microseconds later,
 * and one such file must not fail the whole search/list/save call.
 */
export async function readNoteOrNull(fullPath: string): Promise<string | null> {
  try {
    return await readFile(fullPath, "utf-8");
  } catch {
    return null;
  }
}
