import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import { AgentRoleDefinition, AgentSetupManifest } from "@synara/contracts";
import { expandHome, isMissing, isWithin } from "./files";

const claudeTools: Record<string, readonly string[]> = {
  "filesystem-read": ["Read", "Grep", "Glob"],
  "filesystem-write": ["Edit", "Write"],
  shell: ["Bash"],
};
export function convertClaudeRole(role: AgentRoleDefinition): {
  description: string;
  prompt: string;
  tools?: string[];
} {
  for (const requirement of role.requirements)
    if (!claudeTools[requirement.capability])
      throw new Error(`Unsupported Claude role requirement ${requirement.capability}: ${role.id}`);
  if (role.overrides.some((override) => ["claude", "claude-sdk"].includes(override.client)))
    throw new Error(
      `Explicit model override for ${role.id} requires verified discovery. No model was substituted.`,
    );
  const tools = [
    ...new Set(
      role.requirements.flatMap((requirement) => claudeTools[requirement.capability] ?? []),
    ),
  ];
  return {
    description: role.description,
    prompt: role.instructions,
    ...(tools.length ? { tools } : {}),
  };
}

export async function loadManagedRoles(home: string): Promise<AgentRoleDefinition[]> {
  let registry: AgentSetupManifest;
  try {
    registry = Schema.decodeUnknownSync(AgentSetupManifest)(
      JSON.parse(await fs.readFile(path.join(home, ".agents/setup.json"), "utf8")),
    );
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const roles: AgentRoleDefinition[] = [];
  for (const resource of registry.resources.filter(
    (resource) =>
      resource.kind === "role" && resource.enabled && resource.ownership === "managed-shared",
  )) {
    const source = await fs.realpath(expandHome(resource.source, home));
    if (!isWithin(await fs.realpath(path.join(home, ".agents/catalog/roles")), source))
      throw new Error(`Role source escapes the catalog: ${resource.id}`);
    const role = Schema.decodeUnknownSync(AgentRoleDefinition)(
      JSON.parse(await fs.readFile(source, "utf8")),
    );
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(role.id))
      throw new Error(`Invalid role name: ${role.id}`);
    roles.push(role);
  }
  return roles;
}
