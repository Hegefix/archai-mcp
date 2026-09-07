import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
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

export function getAllMarkdownFiles(vaultPath: string): Promise<string[]> {
  return glob("**/*.md", {
    cwd: vaultPath,
    ignore: [".obsidian/**"],
    nodir: true,
    posix: true,
  });
}

/** Real top-level directories in a vault, excluding `.obsidian`. Empty if the vault root doesn't exist yet. */
export async function listTopLevelFolders(vaultPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(vaultPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== ".obsidian")
    .map((entry) => entry.name)
    .sort();
}

/**
 * Throws unless `relativePath`'s first segment is an existing top-level folder in the vault.
 * A path resolving to the vault root (".") is always allowed.
 */
export async function assertKnownTopLevelFolder(
  vaultPath: string,
  vaultName: string,
  relativePath: string
): Promise<void> {
  const normalized = normalizeVaultPath(relativePath);
  if (normalized === ".") return;
  const topSegment = normalized.split("/")[0] as string;
  const known = await listTopLevelFolders(vaultPath);
  if (!known.includes(topSegment)) {
    const available =
      known.length > 0 ? known.join(", ") : "(none — this vault has no subfolders yet)";
    throw new Error(
      `Unknown top-level folder "${topSegment}" in vault "${vaultName}". ` +
        `Existing top-level folders: ${available}. Pass allowNewTopLevel: true to create it.`
    );
  }
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
