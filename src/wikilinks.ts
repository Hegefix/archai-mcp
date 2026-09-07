/**
 * Wikilink scanning and rewriting.
 *
 * This is a character scanner, not a regex over the whole file: a naive
 * `/\[\[(.+?)\]\]/g` would happily match links inside fenced code blocks, inline
 * code spans and YAML frontmatter, all of which are documentation *about* links
 * rather than links themselves. The vault has a live example — a checklist item
 * reading "creates/updates notes with `[[wikilinks]]`" — that must not be
 * reported as a broken link to a note named "wikilinks".
 *
 * Every link carries its byte offsets and its raw text exactly as written, which
 * is what lets `rewriteWikilinks` swap a target while leaving the alias and
 * heading parts byte-for-byte intact.
 */

export type Wikilink = {
  /** The link exactly as written, e.g. `[[a/b#H|Label]]`. */
  raw: string;
  /** Link target with the `#heading` and `|alias` parts stripped, trimmed. */
  target: string;
  /** Heading anchor without the `#`, when present. Preserved verbatim. */
  heading?: string;
  /** Alias without the `|`, when present. Preserved verbatim. */
  alias?: string;
  /** Offset of the opening `[[` in the source. */
  start: number;
  /** Offset just past the closing `]]`. */
  end: number;
  /** 1-based line number of the opening `[[`. */
  line: number;
  /** 1-based column of the opening `[[`. */
  column: number;
  /** The full source line the link sits on, for marker detection. */
  lineText: string;
};

type Fence = { char: string; len: number };

/** An opening (or closing) code fence: 3+ backticks or tildes, indented at most 3 spaces. */
function fenceAt(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (match === null) return undefined;
  const run = match[1] as string;
  return { char: run[0] as string, len: run.length };
}

/** A fence closes a block only when it matches the opening char and carries no info string. */
function closesFence(line: string, open: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (match === null) return false;
  const run = match[1] as string;
  return (run[0] as string) === open.char && run.length >= open.len;
}

type ParsedInner = Pick<Wikilink, "target" | "heading" | "alias">;

/**
 * Split the inside of a `[[...]]` into target / heading / alias.
 *
 * Obsidian's order is `target#heading|alias`, so the pipe is found first and the
 * hash is looked for only in what precedes it — otherwise an alias containing a
 * `#` would be mistaken for a heading. Returns undefined for forms that don't
 * name another note: `[[]]` and same-document anchors like `[[#Section]]`.
 */
function parseInner(inner: string): ParsedInner | undefined {
  const pipe = inner.indexOf("|");
  const beforePipe = pipe === -1 ? inner : inner.slice(0, pipe);
  const alias = pipe === -1 ? undefined : inner.slice(pipe + 1);

  const hash = beforePipe.indexOf("#");
  const target = (hash === -1 ? beforePipe : beforePipe.slice(0, hash)).trim();
  const heading = hash === -1 ? undefined : beforePipe.slice(hash + 1);

  if (target === "") return undefined;
  const parsed: ParsedInner = { target };
  if (heading !== undefined) parsed.heading = heading;
  if (alias !== undefined) parsed.alias = alias;
  return parsed;
}

/**
 * Every wikilink in `source` that is a real link, in document order.
 *
 * Skipped as not-links: YAML frontmatter, fenced code blocks, inline code spans,
 * and same-document `[[#anchor]]` forms. Embeds (`![[x]]`) are reported — they do
 * resolve to a target — with the leading `!` left outside `raw`, so rewriting an
 * embed's target keeps it an embed.
 *
 * Inline code spans are matched within a single line. A code span left unclosed on
 * its line is treated as literal backticks, which is where this diverges from
 * CommonMark's multi-line spans; that shape doesn't occur in prose and the
 * alternative (swallowing the rest of the file) is far worse.
 */
export function scanWikilinks(source: string): Wikilink[] {
  const links: Wikilink[] = [];
  const lines = source.split("\n");

  let offset = 0;
  let fence: Fence | undefined;
  let inFrontmatter = (lines[0] as string | undefined)?.trimEnd() === "---";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineStart = offset;
    offset += line.length + 1;

    if (inFrontmatter) {
      const trimmed = line.trimEnd();
      if (i > 0 && (trimmed === "---" || trimmed === "...")) inFrontmatter = false;
      continue;
    }

    if (fence !== undefined) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const opening = fenceAt(line);
    if (opening !== undefined) {
      fence = opening;
      continue;
    }

    let j = 0;
    while (j < line.length) {
      if (line[j] === "`") {
        // Walk the opening backtick run, then look for a closing run of exactly
        // the same length — that pair delimits an inline code span.
        let runLength = 0;
        while (line[j + runLength] === "`") runLength++;

        let k = j + runLength;
        let closeEnd = -1;
        while (k < line.length) {
          if (line[k] !== "`") {
            k++;
            continue;
          }
          let candidate = 0;
          while (line[k + candidate] === "`") candidate++;
          if (candidate === runLength) {
            closeEnd = k + candidate;
            break;
          }
          k += candidate;
        }

        j = closeEnd === -1 ? j + runLength : closeEnd;
        continue;
      }

      if (line[j] === "[" && line[j + 1] === "[") {
        const close = line.indexOf("]]", j + 2);
        if (close === -1) {
          j += 2;
          continue;
        }
        const parsed = parseInner(line.slice(j + 2, close));
        if (parsed !== undefined) {
          links.push({
            ...parsed,
            raw: line.slice(j, close + 2),
            start: lineStart + j,
            end: lineStart + close + 2,
            line: i + 1,
            column: j + 1,
            lineText: line,
          });
        }
        j = close + 2;
        continue;
      }

      j++;
    }
  }

  return links;
}

/** Render a link back to source form, keeping the heading and alias parts as given. */
export function renderWikilink(
  target: string,
  heading?: string,
  alias?: string
): string {
  let inner = target;
  if (heading !== undefined) inner += `#${heading}`;
  if (alias !== undefined) inner += `|${alias}`;
  return `[[${inner}]]`;
}

export type LinkRewrite = {
  link: Wikilink;
  /** The replacement link text. */
  to: string;
};

/**
 * Rewrite link targets in `source`.
 *
 * `retarget` receives each scanned link and returns the new target, or undefined
 * to leave that link alone. Only the target changes: the heading and alias travel
 * through `renderWikilink` untouched, so `[[old|Some Label]]` becomes
 * `[[new|Some Label]]` rather than silently losing the label.
 *
 * Splices run back to front so each link's recorded offsets stay valid.
 */
export function rewriteWikilinks(
  source: string,
  retarget: (link: Wikilink) => string | undefined
): { content: string; changes: LinkRewrite[] } {
  const links = scanWikilinks(source);
  const changes: LinkRewrite[] = [];

  let content = source;
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i] as Wikilink;
    const target = retarget(link);
    if (target === undefined || target === link.target) continue;

    const to = renderWikilink(target, link.heading, link.alias);
    content = content.slice(0, link.start) + to + content.slice(link.end);
    changes.unshift({ link, to });
  }

  return { content, changes };
}
