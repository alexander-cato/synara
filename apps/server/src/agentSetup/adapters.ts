import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentClientBinding,
  AgentClientStatus,
  AgentResourceDescriptor,
} from "@synara/contracts";
import { expandHome, isWithin } from "./files";

export async function detectExecutable(
  executable: string | undefined,
  home: string,
  searchPath = process.env.PATH ?? "",
): Promise<string | undefined> {
  if (!executable) return undefined;
  const candidates = executable.includes("/")
    ? [expandHome(executable, home)]
    : searchPath
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, executable));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return await fs.realpath(candidate);
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return undefined;
}

export function resourceAvailability(
  resource: AgentResourceDescriptor,
  client: AgentClientBinding,
): string | undefined {
  if (!resource.enabled) return "Disabled in the personal registry.";
  const missing = resource.requirements.filter(
    (requirement) => !client.capabilities.includes(requirement.capability),
  );
  if (missing.length)
    return missing
      .map((requirement) => `${requirement.capability}: ${requirement.rationale}`)
      .join("; ");
  if (resource.targetingExceptions.length)
    return "An explicit model restriction must be evaluated for the session; no automatic model substitution is permitted.";
  const feature =
    resource.kind === "skill"
      ? "skills"
      : resource.kind === "role"
        ? "roles"
        : resource.kind === "instructions" || resource.kind === "rule"
          ? "instructions"
          : resource.kind === "mcp"
            ? "mcp"
            : resource.kind === "hook"
              ? "hooks"
              : undefined;
  const support = client.features.find((item) => item.feature === feature);
  if (!support || support.support === "manual" || support.support === "unsupported")
    return support?.limitation ?? "No verified conversion is available for this resource kind.";
  return undefined;
}

export async function inspectClient(
  client: AgentClientBinding,
  resources: readonly AgentResourceDescriptor[],
  home: string,
): Promise<AgentClientStatus> {
  const runtimePath = await detectExecutable(client.executable, home);
  const managed = resources.filter((resource) => resource.ownership.startsWith("managed"));
  const unavailableResources = managed.flatMap((resource) => {
    const reason = resourceAvailability(resource, client);
    return reason ? [{ id: resource.id, reason }] : [];
  });
  const unavailable = new Set(unavailableResources.map((item) => item.id));
  return {
    id: client.id,
    name: client.name,
    configured: client.configured,
    ...(runtimePath ? { runtimePath } : {}),
    features: client.features,
    effectiveResources:
      runtimePath || client.id === "claude-sdk"
        ? managed
            .filter(
              (resource) =>
                !unavailable.has(resource.id) &&
                resource.copies.some(
                  (copy) =>
                    copy.ownership === "generated" &&
                    (resource.kind === "skill"
                      ? client.skillRoots.some((root) =>
                          isWithin(expandHome(root, home), copy.path),
                        ) && copy.packageHash === resource.packageHash
                      : (client.instructionTarget &&
                          copy.path === expandHome(client.instructionTarget, home)) ||
                        (resource.kind === "role" && ["claude", "claude-sdk"].includes(client.id))),
                ),
            )
            .map((resource) => resource.id)
        : [],
    unavailableResources,
    verification: "unverified",
    diagnostics: [
      runtimePath
        ? "Runtime detected. Instruction and skill loading require a client-specific probe."
        : "Runtime unavailable; no client was installed or reported as verified.",
      ...client.features.flatMap((feature) =>
        feature.limitation ? [`${feature.feature}: ${feature.limitation}`] : [],
      ),
      "Local exports do not publish or synchronize cloud resources.",
    ],
  };
}

/** Defaults describe documented loading locations, not a claim of successful live verification. */
export function defaultClientBindings(): AgentClientBinding[] {
  const clients: Array<
    [
      string,
      string,
      string | undefined,
      AgentClientBinding["skillDelivery"],
      string[],
      string | undefined,
      string | undefined,
    ]
  > = [
    [
      "codex",
      "Codex",
      "codex",
      "shared",
      ["~/.agents/skills", "~/.codex/skills"],
      undefined,
      "~/.codex/AGENTS.md",
    ],
    [
      "cursor",
      "Cursor",
      "cursor-agent",
      "shared",
      ["~/.agents/skills", "~/.cursor/skills", "~/.cursor/skills-cursor"],
      undefined,
      undefined,
    ],
    [
      "claude",
      "Claude Code",
      "claude",
      "links",
      ["~/.claude/skills"],
      "~/.claude/skills",
      "~/.claude/CLAUDE.md",
    ],
    [
      "claude-sdk",
      "Embedded Claude SDK",
      undefined,
      "links",
      ["~/.claude/skills"],
      undefined,
      undefined,
    ],
    [
      "opencode",
      "OpenCode",
      "opencode",
      "shared",
      ["~/.agents/skills", "~/.config/opencode/skills"],
      undefined,
      "~/.config/opencode/AGENTS.md",
    ],
    [
      "copilot",
      "Copilot CLI",
      "copilot",
      "shared",
      ["~/.agents/skills", "~/.copilot/skills"],
      undefined,
      "~/.copilot/copilot-instructions.md",
    ],
    [
      "auggie",
      "Auggie",
      "auggie",
      "shared",
      ["~/.agents/skills", "~/.augment/skills"],
      undefined,
      "~/.augment/rules/personal.md",
    ],
    [
      "antigravity-cli",
      "Antigravity CLI",
      "agy",
      "links",
      ["~/.gemini/antigravity-cli/skills"],
      "~/.gemini/antigravity-cli/skills",
      undefined,
    ],
    [
      "antigravity-desktop",
      "Antigravity desktop",
      undefined,
      "links",
      ["~/.gemini/config/skills", "~/.gemini/antigravity/skills"],
      "~/.gemini/config/skills",
      undefined,
    ],
    [
      "grok",
      "Grok",
      "grok",
      "links",
      ["~/.grok/skills", "~/.claude/skills"],
      "~/.grok/skills",
      "~/.grok/AGENTS.md",
    ],
    [
      "junie",
      "Junie",
      "junie",
      "links",
      ["~/.junie/agent-skills"],
      "~/.junie/agent-skills",
      "~/.junie/AGENTS.md",
    ],
    ["gemini", "Gemini CLI", "gemini", "manual", ["~/.gemini/skills"], undefined, undefined],
    ["goose", "Goose", "goose", "manual", ["~/.config/goose/skills"], undefined, undefined],
    ["pi", "Pi", "pi", "manual", ["~/.pi/agent/skills"], undefined, undefined],
    ["omp", "OMP", "omp", "manual", ["~/.omp/agent/skills"], undefined, undefined],
    [
      "devin",
      "Devin",
      "devin",
      "manual",
      ["~/.config/devin/skills", "~/.cognition/skills", "~/.devin/skills"],
      undefined,
      undefined,
    ],
    ["droid", "Droid", "droid", "manual", ["~/.factory/skills"], undefined, undefined],
    ["warp", "Warp", undefined, "manual", [], undefined, undefined],
    ["zed", "Zed", undefined, "manual", [], undefined, undefined],
    ["codeg", "Codeg", undefined, "manual", ["~/.codeg/skills"], undefined, undefined],
    ["orca", "Orca", "orca", "manual", [], undefined, undefined],
    ["conductor", "Conductor", undefined, "manual", [], undefined, undefined],
  ];
  return clients.map(
    ([id, name, executable, skillDelivery, skillRoots, skillTarget, instructionTarget]) => ({
      id,
      name,
      ...(executable ? { executable } : {}),
      configured: true,
      skillDelivery: id === "grok" ? "shared" : skillDelivery,
      skillRoots,
      ...(id === "grok"
        ? {
            skillConfig: {
              path: "~/.grok/config.toml",
              format: "toml" as const,
              field: ["skills", "paths"],
            },
          }
        : skillTarget
          ? { skillTarget }
          : {}),
      ...(id === "opencode"
        ? {
            instructionConfig: {
              path: "~/.config/opencode/opencode.jsonc",
              format: "jsonc" as const,
              field: ["instructions"],
            },
          }
        : {}),
      ...(instructionTarget ? { instructionTarget, instructionFormat: "copy" as const } : {}),
      capabilities: ["filesystem", "filesystem-read", "filesystem-write", "shell"],
      features: [
        {
          feature: "skills",
          support:
            skillDelivery === "manual"
              ? "manual"
              : skillDelivery === "shared"
                ? "native"
                : "generated",
          ...(skillDelivery === "manual"
            ? {
                limitation:
                  "Resources remain visible; native loading has not been verified for this host.",
              }
            : {}),
        },
        {
          feature: "instructions",
          support: instructionTarget ? "generated" : "manual",
          ...(!instructionTarget
            ? {
                limitation:
                  "Personal instruction loading requires a verified adapter; repository AGENTS.md remains canonical.",
              }
            : {}),
        },
        {
          feature: "roles",
          support: id === "claude" ? "generated" : "manual",
          ...(id !== "claude"
            ? {
                limitation:
                  "Role instructions are portable; native tool and model conversion is not verified for this client.",
              }
            : {}),
        },
        {
          feature: "mcp",
          support: "manual",
          limitation:
            "Existing client, Orca, Browserclaw, and Synara gateway registrations retain native ownership.",
        },
        {
          feature: "hooks",
          support: "manual",
          limitation:
            "Existing hooks retain installer ownership. Unsupported event conversions are not generated.",
        },
        {
          feature: "disablement",
          support: skillDelivery === "manual" ? "manual" : "generated",
          limitation:
            "Managed exports can be removed. Client-owned and account-synced resources cannot be disabled by removing shared exports.",
        },
      ],
    }),
  );
}
