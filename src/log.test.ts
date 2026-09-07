import { describe, it, expect } from "vitest";
import { formatLogEntry, appendUnderToday } from "./log.js";

describe("formatLogEntry", () => {
  it("links a created note as a wikilink without the extension", () => {
    expect(formatLogEntry("save", "concepts/react-hooks.md", "React Hooks")).toBe(
      "* **Creation**: [[concepts/react-hooks]] — React Hooks"
    );
  });

  it("omits the title when there isn't one", () => {
    expect(formatLogEntry("update", "concepts/react-hooks.md")).toBe(
      "* **Update**: [[concepts/react-hooks]]"
    );
  });

  it("logs a reference as a plain path, since it may not be markdown", () => {
    expect(formatLogEntry("save_reference", "references/rfc/rfc-9110.txt")).toBe(
      "* **Reference**: references/rfc/rfc-9110.txt"
    );
  });
});

describe("appendUnderToday", () => {
  const entry = "* **Update**: [[a]]";

  it("creates the skeleton for an empty log", () => {
    expect(appendUnderToday("", "2026-08-17", entry)).toBe(
      `# Log\n\n## 2026-08-17\n\n${entry}\n`
    );
  });

  it("adds today's heading at the end when the log has older days", () => {
    const existing = "# Log\n\n## 2026-08-16\n\n* **Creation**: [[b]]\n";
    expect(appendUnderToday(existing, "2026-08-17", entry)).toBe(
      `# Log\n\n## 2026-08-16\n\n* **Creation**: [[b]]\n\n## 2026-08-17\n\n${entry}\n`
    );
  });

  it("appends under an existing today heading", () => {
    const existing = "# Log\n\n## 2026-08-17\n\n* **Creation**: [[b]]\n";
    expect(appendUnderToday(existing, "2026-08-17", entry)).toBe(
      `# Log\n\n## 2026-08-17\n\n* **Creation**: [[b]]\n${entry}\n`
    );
  });

  it("appends to today's section without disturbing the days after it", () => {
    const existing =
      "# Log\n\n## 2026-08-17\n\n* **Creation**: [[b]]\n\n## 2026-08-18\n\n* **Creation**: [[c]]\n";
    expect(appendUnderToday(existing, "2026-08-17", entry)).toBe(
      `# Log\n\n## 2026-08-17\n\n* **Creation**: [[b]]\n${entry}\n\n## 2026-08-18\n\n* **Creation**: [[c]]\n`
    );
  });

  it("separates the entry from an empty today heading", () => {
    const existing = "# Log\n\n## 2026-08-17\n";
    expect(appendUnderToday(existing, "2026-08-17", entry)).toBe(
      `# Log\n\n## 2026-08-17\n\n${entry}\n`
    );
  });

  it("leaves hand-written prose above the sections alone", () => {
    const existing = "# Log\n\nActivity log, appended by archai-mcp.\n\n## 2026-08-17\n\n* x\n";
    expect(appendUnderToday(existing, "2026-08-17", entry)).toContain(
      "Activity log, appended by archai-mcp."
    );
  });
});
