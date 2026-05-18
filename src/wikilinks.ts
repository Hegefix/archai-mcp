import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";

export type LinkKind = "wikilink" | "wikilink_embed" | "markdown";

export interface LinkRef {
  kind: LinkKind;
  raw: string;
  basename: string | null;
  target: string | null;
  alias: string | null;
  heading: string | null;
  blockId: string | null;
  offset: number;
  length: number;
  line: number;
  column: number;
}

export interface Edit {
  offset: number;
  length: number;
  replacement: string;
}

export interface LinkUpdate {
  raw: string;
  replacement: string;
  line: number;
  column: number;
}

interface AstNode {
  type: string;
  position?: { start: { offset: number }; end: { offset: number } };
  children?: AstNode[];
  url?: string;
  value?: string;
}

function parse(content: string): AstNode {
  return fromMarkdown(content, {
    extensions: [frontmatter(["yaml"])],
    mdastExtensions: [frontmatterFromMarkdown(["yaml"])],
  }) as AstNode;
}

export function scanLinks(content: string): LinkRef[] {
  const tree = parse(content);
  const refs: LinkRef[] = [];
  const lineIndex = buildLineIndex(content);
  visit(tree, content, refs, lineIndex);
  refs.sort((a, b) => a.offset - b.offset);
  return refs;
}

function visit(
  node: AstNode,
  content: string,
  refs: LinkRef[],
  lineIndex: number[]
): void {
  if (!node) return;
  switch (node.type) {
    case "text":
      if (node.position) {
        scanWikilinksInRange(
          content,
          node.position.start.offset,
          node.position.end.offset,
          refs,
          lineIndex
        );
      }
      return;
    case "link":
      if (node.position && typeof node.url === "string") {
        const offset = node.position.start.offset;
        const length = node.position.end.offset - offset;
        const lc = offsetToLineCol(offset, lineIndex);
        refs.push({
          kind: "markdown",
          raw: content.slice(offset, offset + length),
          basename: extractBasename(node.url),
          target: node.url,
          alias: null,
          heading: null,
          blockId: null,
          offset,
          length,
          line: lc.line,
          column: lc.column,
        });
      }
      return;
    case "code":
    case "inlineCode":
    case "yaml":
    case "html":
      return;
    default:
      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          visit(child, content, refs, lineIndex);
        }
      }
  }
}

function scanWikilinksInRange(
  content: string,
  start: number,
  end: number,
  refs: LinkRef[],
  lineIndex: number[]
): void {
  let i = start;
  while (i < end) {
    const c = content[i];
    if (c === "\\" && i + 1 < end) {
      i += 2;
      continue;
    }
    if (c === "!" && content[i + 1] === "[" && content[i + 2] === "[") {
      const close = findWikilinkClose(content, i + 3, end);
      if (close !== -1) {
        recordWikilink(content, i, close, "wikilink_embed", refs, lineIndex);
        i = close + 2;
        continue;
      }
    }
    if (c === "[" && content[i + 1] === "[") {
      const close = findWikilinkClose(content, i + 2, end);
      if (close !== -1) {
        recordWikilink(content, i, close, "wikilink", refs, lineIndex);
        i = close + 2;
        continue;
      }
    }
    i++;
  }
}

function findWikilinkClose(content: string, from: number, end: number): number {
  for (let i = from; i < end - 1; i++) {
    const c = content[i];
    if (c === "\n") return -1;
    if (c === "[" && content[i + 1] === "[") return -1;
    if (c === "]" && content[i + 1] === "]") return i;
  }
  return -1;
}

function recordWikilink(
  content: string,
  startBracket: number,
  closeBracket: number,
  kind: LinkKind,
  refs: LinkRef[],
  lineIndex: number[]
): void {
  const prefixLen = kind === "wikilink_embed" ? 3 : 2;
  const inner = content.slice(startBracket + prefixLen, closeBracket);
  const parsed = parseWikilinkInner(inner);
  const length = closeBracket + 2 - startBracket;
  const lc = offsetToLineCol(startBracket, lineIndex);
  refs.push({
    kind,
    raw: content.slice(startBracket, startBracket + length),
    basename: parsed.basename,
    target: parsed.target,
    alias: parsed.alias,
    heading: parsed.heading,
    blockId: parsed.blockId,
    offset: startBracket,
    length,
    line: lc.line,
    column: lc.column,
  });
}

interface ParsedInner {
  basename: string;
  target: string;
  alias: string | null;
  heading: string | null;
  blockId: string | null;
}

function parseWikilinkInner(inner: string): ParsedInner {
  let target = inner;
  let alias: string | null = null;
  const pipeIdx = inner.indexOf("|");
  if (pipeIdx !== -1) {
    target = inner.slice(0, pipeIdx);
    alias = inner.slice(pipeIdx + 1);
  }
  let basePath = target;
  let heading: string | null = null;
  let blockId: string | null = null;
  const hashIdx = target.indexOf("#");
  if (hashIdx !== -1) {
    basePath = target.slice(0, hashIdx);
    const fragment = target.slice(hashIdx + 1);
    if (fragment.startsWith("^")) {
      blockId = fragment.slice(1);
    } else {
      heading = fragment;
    }
  }
  let basename = basePath;
  const lastSlash = basename.lastIndexOf("/");
  if (lastSlash !== -1) basename = basename.slice(lastSlash + 1);
  if (basename.endsWith(".md")) basename = basename.slice(0, -3);
  return { basename, target, alias, heading, blockId };
}

function extractBasename(url: string): string | null {
  const cleaned = url.split("#")[0]?.split("?")[0] ?? "";
  if (!cleaned.endsWith(".md")) return null;
  const lastSlash = cleaned.lastIndexOf("/");
  const fname = lastSlash !== -1 ? cleaned.slice(lastSlash + 1) : cleaned;
  return decodeURIComponent(fname.slice(0, -3));
}

function buildLineIndex(content: string): number[] {
  const idx: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") idx.push(i + 1);
  }
  return idx;
}

function offsetToLineCol(
  offset: number,
  lineIndex: number[]
): { line: number; column: number } {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineIndex[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineIndex[lo]! + 1 };
}

export function rewriteWikilinks(
  content: string,
  fromBasename: string,
  toBasename: string
): { content: string; updates: LinkUpdate[] } {
  if (fromBasename === toBasename) return { content, updates: [] };
  const refs = scanLinks(content);
  const edits: Edit[] = [];
  const updates: LinkUpdate[] = [];
  for (const ref of refs) {
    if (ref.kind !== "wikilink" && ref.kind !== "wikilink_embed") continue;
    if (ref.basename !== fromBasename) continue;
    const prefix = ref.kind === "wikilink_embed" ? "![[" : "[[";
    let body = toBasename;
    if (ref.heading) body += "#" + ref.heading;
    if (ref.blockId) body += "#^" + ref.blockId;
    if (ref.alias !== null) body += "|" + ref.alias;
    const replacement = prefix + body + "]]";
    edits.push({ offset: ref.offset, length: ref.length, replacement });
    updates.push({
      raw: ref.raw,
      replacement,
      line: ref.line,
      column: ref.column,
    });
  }
  return { content: applyEdits(content, edits), updates };
}

export function rewriteMarkdownLinks(
  content: string,
  predicate: (url: string) => string | null
): { content: string; updates: LinkUpdate[] } {
  const refs = scanLinks(content);
  const edits: Edit[] = [];
  const updates: LinkUpdate[] = [];
  for (const ref of refs) {
    if (ref.kind !== "markdown" || !ref.target) continue;
    const newUrl = predicate(ref.target);
    if (newUrl === null || newUrl === ref.target) continue;
    const closeBracket = ref.raw.indexOf("](");
    if (closeBracket === -1) continue;
    const text = ref.raw.slice(1, closeBracket);
    const replacement = `[${text}](${newUrl})`;
    edits.push({ offset: ref.offset, length: ref.length, replacement });
    updates.push({
      raw: ref.raw,
      replacement,
      line: ref.line,
      column: ref.column,
    });
  }
  return { content: applyEdits(content, edits), updates };
}

export function applyEdits(content: string, edits: Edit[]): string {
  if (edits.length === 0) return content;
  const sorted = [...edits].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.offset < prev.offset + prev.length) {
      throw new Error("overlapping edits");
    }
  }
  let result = content;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const edit = sorted[i]!;
    result =
      result.slice(0, edit.offset) +
      edit.replacement +
      result.slice(edit.offset + edit.length);
  }
  return result;
}

export function contextSnippet(
  content: string,
  offset: number,
  length: number,
  width = 80
): string {
  const pad = Math.max(0, Math.floor((width - length) / 2));
  const start = Math.max(0, offset - pad);
  const end = Math.min(content.length, start + width);
  let snippet = content.slice(start, end).replace(/\n/g, " ");
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";
  return snippet;
}
