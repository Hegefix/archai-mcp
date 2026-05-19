import { scanLinks, applyEdits, type Edit } from "./wikilinks.js";

const KEBAB_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const ATTACHMENT_EXT_SET = new Set<string>([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".mp4",
  ".mov",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".zip",
  ".csv",
  ".xlsx",
  ".docx",
]);

function hasAttachmentExt(s: string): boolean {
  const dot = s.lastIndexOf(".");
  if (dot === -1) return false;
  return ATTACHMENT_EXT_SET.has(s.slice(dot).toLowerCase());
}

export function toWikilinkKebab(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[—–_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface WikilinkChange {
  from: string;
  to: string;
}

export interface NormalizeResult {
  content: string;
  changes: WikilinkChange[];
}

export function normalizeWikilinks(content: string): NormalizeResult {
  const refs = scanLinks(content);
  const edits: Edit[] = [];
  const changes: WikilinkChange[] = [];

  for (const ref of refs) {
    if (ref.kind !== "wikilink" && ref.kind !== "wikilink_embed") continue;
    if (ref.target === null) continue;

    const target = ref.target;
    const hashIdx = target.indexOf("#");
    const basePath = hashIdx === -1 ? target : target.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? "" : target.slice(hashIdx);

    if (basePath.length === 0) continue;
    if (basePath.includes("/")) continue;
    if (hasAttachmentExt(basePath)) continue;
    if (KEBAB_RE.test(basePath)) continue;

    const newBase = toWikilinkKebab(basePath);
    if (newBase.length === 0 || newBase === basePath) continue;

    const prefix = ref.kind === "wikilink_embed" ? "![[" : "[[";
    let body = newBase + fragment;
    if (ref.alias !== null) body += "|" + ref.alias;
    const replacement = prefix + body + "]]";

    edits.push({ offset: ref.offset, length: ref.length, replacement });
    changes.push({ from: ref.raw, to: replacement });
  }

  return { content: applyEdits(content, edits), changes };
}
