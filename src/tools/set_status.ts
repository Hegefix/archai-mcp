import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import matter from "gray-matter";
import { readFile, writeFile } from "node:fs/promises";
import { resolveVaultPath } from "../paths.js";
import { todayISO } from "../text.js";

const STATUS_VALUES = ["seedling", "growing", "evergreen"] as const;
type Status = (typeof STATUS_VALUES)[number];

export function registerSetStatus(server: McpServer, vaultPath: string): void {
  server.registerTool(
    "set_status",
    {
      description:
        "Change a note's `status` frontmatter field. Valid values: `seedling`, `growing`, `evergreen`. Bumps the `updated` field. Use this to promote notes as they mature — seedling for drafts, growing for active work, evergreen for settled material safe to link to publicly.",
      inputSchema: {
        path: z.string().describe("Relative path to the note"),
        status: z
          .enum(STATUS_VALUES)
          .describe("New status: seedling, growing, or evergreen"),
      },
    },
    async ({ path: notePath, status }) => {
      if (!notePath.toLowerCase().endsWith(".md")) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: path must point to a .md file: ${notePath}`,
            },
          ],
          isError: true,
        };
      }

      const fullPath = resolveVaultPath(vaultPath, notePath);
      let existing: string;
      try {
        existing = await readFile(fullPath, "utf-8");
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: file not found at ${notePath}`,
            },
          ],
          isError: true,
        };
      }

      const parsed = matter(existing);
      const raw = parsed.data["status"];
      const previousStatus: Status | null =
        typeof raw === "string" && (STATUS_VALUES as readonly string[]).includes(raw)
          ? (raw as Status)
          : null;

      const changed = previousStatus !== status;

      let text: string;
      if (!changed) {
        text = `Status unchanged: ${notePath} — already ${status}`;
      } else {
        parsed.data["status"] = status;
        parsed.data["updated"] = todayISO();
        const updated = matter.stringify(
          parsed.content,
          parsed.data as Record<string, unknown>
        );
        await writeFile(fullPath, updated, "utf-8");
        text =
          previousStatus === null
            ? `Status set: ${notePath} — ${status}`
            : `Status: ${notePath} — ${previousStatus} → ${status}`;
      }

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          path: notePath,
          previous_status: previousStatus,
          new_status: status,
          changed,
        },
      };
    }
  );
}
