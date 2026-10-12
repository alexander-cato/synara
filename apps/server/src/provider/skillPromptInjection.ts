// FILE: skillPromptInjection.ts
// Purpose: Inlines portable skill instructions into the outgoing prompt for providers
//          that cannot natively load the referenced skill files. This is the fallback
//          that makes Synara catalog skills usable on every provider.
// Layer: Server provider helper
// Exports: shouldInlineSkillForProvider, buildInlineSkillInstructions

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderKind, ProviderSkillReference } from "@synara/contracts";
import { isWithin, walkSkillManifests } from "../agentSetup/files";

// Per-skill cap keeps a single oversized SKILL.md from eating the turn budget.
const MAX_INLINE_SKILL_CONTENT_CHARS = 24_000;

const INLINE_SKILLS_HEADER =
  "The user invoked the following agent skill(s) for this request. Follow each " +
  "skill's instructions. File paths referenced inside a skill are relative to its " +
  '"dir" attribute.';

// Loading is a client capability supplied by the adapter, never inferred from
// a provider-looking segment embedded somewhere in a filename.
export function shouldInlineSkillForProvider(
  _provider: ProviderKind,
  skillPath: string,
  nativeRoots: readonly string[] = [],
): boolean {
  return !nativeRoots.some((root) => isWithin(nodePath.resolve(root), nodePath.resolve(skillPath)));
}

export async function buildInlineSkillInstructions(input: {
  readonly provider: ProviderKind;
  readonly skills: ReadonlyArray<ProviderSkillReference>;
  readonly maxChars: number;
  readonly nativeSkillRoots?: readonly string[];
}): Promise<string> {
  const nativePaths = new Set<string>();
  for (const root of input.nativeSkillRoots ?? []) {
    for (const manifest of await walkSkillManifests(root)) {
      nativePaths.add(await fs.realpath(manifest).catch(() => manifest));
    }
  }
  const inlineSkills: ProviderSkillReference[] = [];
  for (const skill of input.skills) {
    const actual = await fs.realpath(skill.path).catch(() => skill.path);
    if (!nativePaths.has(actual)) inlineSkills.push(skill);
  }
  if (inlineSkills.length === 0 || input.maxChars <= 0) {
    return "";
  }

  let text = "";
  for (const skill of inlineSkills) {
    let content: string;
    try {
      content = await fs.readFile(skill.path, "utf8");
    } catch {
      continue;
    }
    let trimmed = content.trim();
    if (trimmed.length > MAX_INLINE_SKILL_CONTENT_CHARS) {
      trimmed = `${trimmed.slice(0, MAX_INLINE_SKILL_CONTENT_CHARS)}\n[skill content truncated]`;
    }
    const block = `<skill name=${JSON.stringify(skill.name)} dir=${JSON.stringify(
      nodePath.dirname(skill.path),
    )}>\n${trimmed}\n</skill>`;
    const candidate =
      text.length === 0 ? `${INLINE_SKILLS_HEADER}\n\n${block}` : `${text}\n\n${block}`;
    if (candidate.length > input.maxChars) {
      // Keep whatever already fits instead of overflowing the provider turn budget.
      break;
    }
    text = candidate;
  }
  return text;
}
