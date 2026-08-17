import { describe, it, expect } from "vitest";
import { mergeSources, sourceKey } from "./sources.js";

describe("sourceKey", () => {
  it("distinguishes a resource from one of its items", () => {
    expect(sourceKey({ resource: "confluence" })).not.toBe(
      sourceKey({ resource: "confluence", id: "123" })
    );
  });

  it("does not collide across the resource/id boundary", () => {
    expect(sourceKey({ resource: "a b" })).not.toBe(sourceKey({ resource: "a", id: "b" }));
  });
});

describe("mergeSources", () => {
  it("returns normalized incoming entries when there is nothing to merge into", () => {
    expect(mergeSources(undefined, [{ resource: "https://example.com" }])).toEqual([
      { resource: "https://example.com" },
    ]);
  });

  it("drops undefined and empty optional fields", () => {
    expect(
      mergeSources([], [{ resource: "slack", id: "C123", title: "", author: undefined }])
    ).toEqual([{ resource: "slack", id: "C123" }]);
  });

  it("appends a new entry after the existing ones", () => {
    const merged = mergeSources(
      [{ resource: "slack", id: "C1" }],
      [{ resource: "jira", id: "ABC-1" }]
    );
    expect(merged).toEqual([
      { resource: "slack", id: "C1" },
      { resource: "jira", id: "ABC-1" },
    ]);
  });

  it("merges field-wise onto a matching resource+id, keeping its position", () => {
    const merged = mergeSources(
      [
        { resource: "slack", id: "C1", title: "Old title" },
        { resource: "jira", id: "ABC-1" },
      ],
      [{ resource: "slack", id: "C1", last_modified: "2026-08-17", title: "New title" }]
    );
    expect(merged).toEqual([
      {
        resource: "slack",
        id: "C1",
        title: "New title",
        last_modified: "2026-08-17",
      },
      { resource: "jira", id: "ABC-1" },
    ]);
  });

  it("treats a differing id as a separate entry", () => {
    const merged = mergeSources(
      [{ resource: "slack", id: "C1" }],
      [{ resource: "slack", id: "C2" }]
    );
    expect(merged).toHaveLength(2);
  });

  it("dedupes within a single incoming batch", () => {
    const merged = mergeSources(
      [],
      [
        { resource: "slack", id: "C1" },
        { resource: "slack", id: "C1", author: "vk" },
      ]
    );
    expect(merged).toEqual([{ resource: "slack", id: "C1", author: "vk" }]);
  });

  it("ignores existing frontmatter that isn't usable source data", () => {
    expect(mergeSources("not a list", [{ resource: "slack" }])).toEqual([
      { resource: "slack" },
    ]);
    expect(mergeSources([{ nope: true }, { resource: "slack" }], [])).toEqual([
      { resource: "slack" },
    ]);
  });

  it("keeps a single existing object rather than dropping it", () => {
    expect(mergeSources({ resource: "slack" }, [{ resource: "jira" }])).toEqual([
      { resource: "slack" },
      { resource: "jira" },
    ]);
  });
});
