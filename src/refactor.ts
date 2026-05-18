import * as path from "node:path";
import matter from "gray-matter";
import {
  getAllMarkdownFiles,
  vaultBasename,
  relativeFromTo,
} from "./paths.js";
import {
  rewriteMarkdownLinks,
  type LinkUpdate,
} from "./wikilinks.js";
import { todayISO } from "./text.js";

export function resolveMarkdownLinkUrl(
  notePath: string,
  linkUrl: string
): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(linkUrl)) return null;
  if (linkUrl.startsWith("#")) return null;
  const cleaned = linkUrl.split("#")[0]?.split("?")[0] ?? "";
  if (!cleaned) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(cleaned);
  } catch {
    decoded = cleaned;
  }
  const noteDir = path.posix.dirname(notePath);
  const joined = path.posix.normalize(
    path.posix.join(noteDir, decoded)
  );
  if (joined === ".." || joined.startsWith("../")) return null;
  return joined;
}

export function recomputeOutgoingMarkdownLinks(
  content: string,
  oldNotePath: string,
  newNotePath: string
): { content: string; updates: LinkUpdate[] } {
  return rewriteMarkdownLinks(content, (url) => {
    const resolved = resolveMarkdownLinkUrl(oldNotePath, url);
    if (resolved === null) return null;
    return relativeFromTo(newNotePath, resolved);
  });
}

export function recomputeMovedFileLinks(
  content: string,
  oldNotePath: string,
  newNotePath: string,
  pathMap: Map<string, string>
): { content: string; updates: LinkUpdate[] } {
  return rewriteMarkdownLinks(content, (url) => {
    const resolved = resolveMarkdownLinkUrl(oldNotePath, url);
    if (resolved === null) return null;
    const newTarget = pathMap.get(resolved) ?? resolved;
    return relativeFromTo(newNotePath, newTarget);
  });
}

export function rewriteMarkdownLinksByPathMap(
  content: string,
  notePath: string,
  pathMap: Map<string, string>
): { content: string; updates: LinkUpdate[] } {
  if (pathMap.size === 0) return { content, updates: [] };
  return rewriteMarkdownLinks(content, (url) => {
    const resolved = resolveMarkdownLinkUrl(notePath, url);
    if (resolved === null) return null;
    const newPath = pathMap.get(resolved);
    if (newPath === undefined) return null;
    return relativeFromTo(notePath, newPath);
  });
}

export function bumpUpdated(content: string): string {
  const parsed = matter(content);
  if (!parsed.matter) return content;
  parsed.data["updated"] = todayISO();
  return matter.stringify(
    parsed.content,
    parsed.data as Record<string, unknown>
  );
}

export async function findAmbiguityConflicts(
  vaultPath: string,
  basename: string,
  excludePaths: Iterable<string>
): Promise<string[]> {
  const exclude = new Set(excludePaths);
  const files = await getAllMarkdownFiles(vaultPath);
  const conflicts: string[] = [];
  for (const f of files) {
    if (exclude.has(f)) continue;
    if (vaultBasename(f) === basename) conflicts.push(f);
  }
  return conflicts;
}
