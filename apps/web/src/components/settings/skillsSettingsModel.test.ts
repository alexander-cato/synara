// FILE: skillsSettingsModel.test.ts
// Purpose: Locks down Settings -> Skills grouping for duplicate provider skill copies.
// Layer: Web settings logic tests

import type { ProviderSkillDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildSettingsSkillGroups,
  buildSettingsSkillSectionsFromGroups,
  enableAgentResourceVisibility,
} from "./skillsSettingsModel";

function skill(partial: Partial<ProviderSkillDescriptor>): ProviderSkillDescriptor {
  return {
    name: "example",
    enabled: true,
    path: "/tmp/example/SKILL.md",
    ...partial,
  };
}

describe("buildSettingsSkillGroups", () => {
  it("groups explicit bindings of one identity and preserves unrelated names", () => {
    const groups = buildSettingsSkillGroups([
      skill({
        resourceId: "skill:check-code",
        name: "check-code",
        description: "Codex copy",
        path: "/Users/test/.codex/skills/check-code/SKILL.md",
        scope: "codex",
      }),
      skill({
        resourceId: "skill:check-code",
        name: "check-code",
        description: "Claude copy",
        path: "/Users/test/.claude/skills/check-code/SKILL.md",
        scope: "claude",
      }),
      skill({
        resourceId: "external:cursor-only",
        name: "cursor-only",
        path: "/Users/test/.cursor/skills/cursor-only/SKILL.md",
        scope: "cursor",
      }),
    ]);

    const shared = groups.find((group) => group.key === "skill:check-code");
    expect(shared?.section).toBe("shared");
    expect(shared?.providers).toEqual(["codex", "claudeAgent"]);
    expect(shared?.sources.map((source) => source.origin)).toEqual(["codex", "claude"]);
    expect(shared?.sources.map((source) => source.skill.path)).toEqual([
      "/Users/test/.codex/skills/check-code/SKILL.md",
      "/Users/test/.claude/skills/check-code/SKILL.md",
    ]);

    const cursorOnly = groups.find((group) => group.key === "external:cursor-only");
    expect(cursorOnly?.section).toBe("cursor");
    expect(cursorOnly?.providers).toEqual(["cursor"]);
    const sections = buildSettingsSkillSectionsFromGroups(groups);
    expect(sections.map((section) => section.title)).toEqual(["Shared skills", "From Cursor"]);
    expect(sections[0]?.groups.map((group) => group.key)).toEqual(["skill:check-code"]);
  });

  it("does not show provider icons for shared alias-only skills", () => {
    const groups = buildSettingsSkillGroups([
      skill({
        name: "portable-review",
        description: "Shared standard copy",
        path: "/Users/test/.agents/skills/portable-review/SKILL.md",
        scope: "agents",
      }),
    ]);

    expect(groups[0]?.providers).toEqual([]);
    expect(groups[0]?.section).toBe("agents");
  });
  it("never combines unverified or divergent same-name copies", () => {
    const groups = buildSettingsSkillGroups([
      skill({ path: "/one/SKILL.md", packageHash: "hash-one" }),
      skill({ path: "/two/SKILL.md", packageHash: "hash-two" }),
      skill({ path: "/three/SKILL.md" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.sources.length === 1)).toBe(true);
  });
});

describe("resource visibility", () => {
  const shared = {
    id: "skill:review",
    name: "review",
    aliases: ["check-code"],
    kind: "skill" as const,
  };
  const native = { id: "external:native", name: "review", aliases: [], kind: "skill" as const };
  const alias = {
    id: "external:alias",
    name: "other-review",
    aliases: ["check-code"],
    kind: "skill" as const,
  };
  it("enables one shared resource while preserving legacy restrictions on same-name and alias variants", () => {
    expect(
      enableAgentResourceVisibility(["REVIEW", "check-code", "unrelated"], shared, [
        shared,
        native,
        alias,
      ]),
    ).toEqual(["external:alias", "external:native", "unrelated"]);
  });
  it("removes only the selected identity when no legacy name restriction applies", () => {
    expect(
      enableAgentResourceVisibility([shared.id, native.id, "unrelated"], shared, [shared, native]),
    ).toEqual([native.id, "unrelated"]);
  });
});
