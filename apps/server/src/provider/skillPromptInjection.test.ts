// FILE: skillPromptInjection.test.ts
// Purpose: Verifies which providers receive inlined portable skill instructions
//          and that the inline text respects the turn character budget.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildInlineSkillInstructions,
  shouldInlineSkillForProvider,
} from "./skillPromptInjection.ts";

describe("shouldInlineSkillForProvider", () => {
  it("uses declared loading roots rather than provider-looking path names", () => {
    for (const provider of [
      "codex",
      "cursor",
      "claudeAgent",
      "antigravity",
      "grok",
      "opencode",
    ] as const) {
      expect(
        shouldInlineSkillForProvider(provider, "/fixture/native/example/SKILL.md", [
          "/fixture/native",
        ]),
      ).toBe(false);
      expect(
        shouldInlineSkillForProvider(provider, "/fixture/project/.claude/skills/example/SKILL.md", [
          "/fixture/native",
        ]),
      ).toBe(true);
      expect(
        shouldInlineSkillForProvider(provider, "/fixture/native-copy/example/SKILL.md", [
          "/fixture/native",
        ]),
      ).toBe(true);
      expect(shouldInlineSkillForProvider(provider, "/fixture/native/example/SKILL.md")).toBe(true);
    }
  });
});

describe("buildInlineSkillInstructions", () => {
  it("inlines skill content for non-native providers and skips unreadable paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-inline-"));
    const skillDir = path.join(root, ".synara", "skills", "reviewer");
    try {
      await mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, "# Reviewer\n\nAlways review carefully.");

      const text = await buildInlineSkillInstructions({
        provider: "antigravity",
        skills: [
          { name: "reviewer", path: skillPath },
          { name: "missing", path: path.join(root, ".synara", "skills", "missing", "SKILL.md") },
        ],
        maxChars: 10_000,
      });

      expect(text).toContain('<skill name="reviewer"');
      expect(text).toContain("Always review carefully.");
      expect(text).not.toContain("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty text when nothing fits in the budget", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-inline-budget-"));
    const skillDir = path.join(root, ".synara", "skills", "reviewer");
    try {
      await mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, "content".repeat(100));

      const text = await buildInlineSkillInstructions({
        provider: "antigravity",
        skills: [{ name: "reviewer", path: skillPath }],
        maxChars: 50,
      });

      expect(text).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([".synara", ".agents"])(
    "does not duplicate %s skill instructions loaded natively by Codex",
    async (skillRoot) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "skill-native-"));
      const skillDir = path.join(root, skillRoot, "skills", "reviewer");
      try {
        await mkdir(skillDir, { recursive: true });
        const skillPath = path.join(skillDir, "SKILL.md");
        await writeFile(skillPath, "# Reviewer\n\nAlways review carefully.");

        const text = await buildInlineSkillInstructions({
          provider: "codex",
          nativeSkillRoots: [skillDir],
          skills: [{ name: "reviewer", path: skillPath }],
          maxChars: 10_000,
        });
        expect(text).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
