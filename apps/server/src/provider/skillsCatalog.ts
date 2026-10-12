// FILE: skillsCatalog.ts
// Purpose: Generic Agent Skill discovery primitives (frontmatter parsing, SKILL.md
//          walking) plus the unified cross-provider skills catalog backing Synara
//          portable skills. Aggregates `~/.synara/skills` with every provider-native
//          skills folder, retaining distinct resources and binding managed copies
//          to their portable source identities.
// Layer: Server provider discovery helper
// Exports: parseSkillFrontmatter, collectSkillsFromRoots, discoverSkillsCatalog,
//          mergeSkillsIntoCatalog, filterDisabledSkills, ensureSynaraSkillsDir

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderKind, ProviderSkillDescriptor } from "@synara/contracts";
import YAML from "yaml";
import { digest, hashPackage, walkSkillManifests } from "../agentSetup/files";
import { discoverClaudePluginSkillRoots } from "./claudePluginSkills.ts";

type FrontmatterValue = string | boolean;

export interface SkillRoot {
  readonly path: string;
  readonly scope: string;
  readonly includeMarkdownFiles?: boolean;
  /** Prefix used by plugin-provided skills whose native invocation is namespaced. */
  readonly namespace?: string;
  /** Provider-owned plugin caches should not traverse linked content outside the install. */
  readonly followSymlinks?: boolean;
}

// ── Frontmatter parsing ──────────────────────────────────────────────

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseYamlScalar(value: string): FrontmatterValue {
  const unquoted = stripYamlQuotes(value);
  const normalized = unquoted.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return unquoted;
}

// Some skills keep their short description under `metadata:`, which the line reader used to pick up.
function readMetadataShortDescription(parsed: object): string | undefined {
  const metadata = (parsed as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)["short-description"];
  return typeof value === "string" ? value.trim() : undefined;
}

// Reads Agent Skills frontmatter as YAML so block scalars (`description: >-`) and nested maps
// parse correctly. Frontmatter that is not valid YAML falls back to the lenient line reader.
export function parseSkillFrontmatter(markdown: string): Record<string, FrontmatterValue> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(normalized);
  if (!match) {
    return {};
  }
  const block = match[1] ?? "";

  try {
    // Skill files can come from untrusted repositories: `uniqueKeys: false` skips the quadratic
    // duplicate-key check, and `logLevel: "error"` keeps unusual tags from printing process warnings.
    const parsed: unknown = YAML.parse(block, { uniqueKeys: false, logLevel: "error" });
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record: Record<string, FrontmatterValue> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          record[key] = value.trim();
        } else if (typeof value === "boolean") {
          record[key] = value;
        }
      }
      const shortDescription = readMetadataShortDescription(parsed);
      if (shortDescription !== undefined && record["short-description"] === undefined) {
        record["short-description"] = shortDescription;
      }
      return record;
    }
  } catch {
    // Not valid YAML: use the line reader below.
  }

  const record: Record<string, FrontmatterValue> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    record[key] = parseYamlScalar(value);
  }
  return record;
}

function readStringField(
  frontmatter: Record<string, FrontmatterValue>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readBooleanField(
  frontmatter: Record<string, FrontmatterValue>,
  keys: ReadonlyArray<string>,
): boolean | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

// ── Filesystem walking ───────────────────────────────────────────────

export function ancestorsFromDeepest(cwd: string): string[] {
  const resolved = nodePath.resolve(cwd);
  const ancestors: string[] = [];
  let current = resolved;
  while (true) {
    ancestors.push(current);
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return ancestors;
    }
    current = parent;
  }
}

export async function collectSkillMarkdownPaths(
  rootPath: string,
  options?: { readonly includeMarkdownFiles?: boolean; readonly followSymlinks?: boolean },
): Promise<string[]> {
  return walkSkillManifests(rootPath, options);
}

export async function readSkillDescriptor(input: {
  readonly skillPath: string;
  readonly scope: string;
  readonly namespace?: string;
}): Promise<ProviderSkillDescriptor | null> {
  let raw: string;
  try {
    raw = await fs.readFile(input.skillPath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseSkillFrontmatter(raw);
  const skillFilename = nodePath.basename(input.skillPath);
  const fallbackName =
    skillFilename.toLowerCase() === "skill.md"
      ? nodePath.basename(nodePath.dirname(input.skillPath))
      : nodePath.basename(input.skillPath, nodePath.extname(input.skillPath));
  const unqualifiedName = readStringField(frontmatter, ["name"]) ?? fallbackName;
  const name =
    input.namespace && !unqualifiedName.includes(":")
      ? `${input.namespace}:${unqualifiedName}`
      : unqualifiedName;
  const description = readStringField(frontmatter, ["description"]);
  const displayName = readStringField(frontmatter, ["display-name", "displayName", "title"]);
  const shortDescription = readStringField(frontmatter, [
    "short-description",
    "shortDescription",
    "summary",
  ]);
  const disabled =
    readBooleanField(frontmatter, ["disable-model-invocation", "disableModelInvocation"]) === true;

  const canonicalPath = await fs.realpath(input.skillPath).catch(() => input.skillPath);
  const packageHash = await hashPackage(
    skillFilename.toLowerCase() === "skill.md" ? nodePath.dirname(canonicalPath) : canonicalPath,
  )
    .then((result) => result.hash)
    .catch(() => undefined);
  return {
    resourceId: `external:${digest(skillFilename.toLowerCase() === "skill.md" ? nodePath.dirname(canonicalPath) : canonicalPath).slice(0, 24)}`,
    canonicalPath,
    ...(packageHash ? { packageHash } : {}),
    name,
    ...(description ? { description } : {}),
    path: input.skillPath,
    enabled: !disabled,
    scope: input.scope,
    ...(displayName || shortDescription
      ? {
          interface: {
            ...(displayName ? { displayName } : {}),
            ...(shortDescription ? { shortDescription } : {}),
          },
        }
      : {}),
  };
}

export function skillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

async function collectSkillDescriptorsFromRoots(
  roots: ReadonlyArray<SkillRoot>,
): Promise<ProviderSkillDescriptor[]> {
  const skillsPerRoot = await Promise.all(
    roots.map(async (root) => {
      const skillPaths = await collectSkillMarkdownPaths(
        root.path,
        root.includeMarkdownFiles || root.followSymlinks === false
          ? {
              ...(root.includeMarkdownFiles ? { includeMarkdownFiles: true } : {}),
              ...(root.followSymlinks === false ? { followSymlinks: false } : {}),
            }
          : undefined,
      );
      const descriptors = await Promise.all(
        skillPaths.map((skillPath) =>
          readSkillDescriptor({
            skillPath,
            scope: root.scope,
            ...(root.namespace ? { namespace: root.namespace } : {}),
          }),
        ),
      );
      return descriptors.filter((skill) => skill !== null);
    }),
  );
  const identities = new Set<string>();
  return skillsPerRoot.flat().filter((skill) => {
    const identity = `${skill.canonicalPath ?? skill.path}:${skill.name.includes(":") ? skill.name : ""}`;
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}

// Scans roots concurrently, retaining distinct packages in root order.
export async function collectSkillsFromRoots(
  roots: ReadonlyArray<SkillRoot>,
): Promise<ProviderSkillDescriptor[]> {
  const allSkills = await collectSkillDescriptorsFromRoots(roots);
  return allSkills;
}

// ── Unified cross-provider catalog ───────────────────────────────────

export interface SkillsCatalogDiscoveryInput {
  /** Optional workspace cwd; when present, project-level skill folders are included. */
  readonly cwd?: string | null;
  readonly homeDir: string;
  /** Synara base dir (usually `~/.synara`); skills live in `{base}/skills`. */
  readonly synaraBaseDir: string;
  /** Provider whose native locations should be scanned first. */
  readonly provider?: ProviderKind | null;
  /** Settings also needs disabled resources; picker discovery hides them. */
  readonly includeDuplicateOrigins?: boolean;
  /** Bypass the short-lived discovery cache. */
  readonly forceReload?: boolean;
  /** Provider-configured agent dir (pi/omp) — overrides the default profile root. */
  readonly agentDir?: string | null;
}

export interface SkillsCatalogRootInput extends SkillsCatalogDiscoveryInput {
  /** Native provider scans can opt out; the catalog itself always includes Synara. */
  readonly includeSynaraRoot?: boolean;
}

const HOME_ORIGIN_ORDER = [
  "synara",
  "codex",
  "claude",
  "cursor",
  "grok",
  "factory",
  "opencode",
  "pi",
  "devin",
  "omp",
  "agents",
  "codeg",
  "antigravity",
  "copilot",
  "auggie",
  "junie",
  "gemini",
  "goose",
] as const;
export type SkillsCatalogOrigin = (typeof HOME_ORIGIN_ORDER)[number] | "project";

// Composer skill pickers refetch aggressively (per keystroke, per provider); a
// short TTL absorbs that burst while still picking up new skill files quickly.
const SKILLS_CATALOG_CACHE_TTL_MS = 15_000;
const SKILLS_CATALOG_CACHE_MAX_ENTRIES = 64;

interface SkillsCatalogCacheEntry {
  readonly at: number;
  readonly skills: ReadonlyArray<ProviderSkillDescriptor>;
}

const skillsCatalogCache = new Map<string, SkillsCatalogCacheEntry>();
const skillsCatalogInflight = new Map<string, Promise<ReadonlyArray<ProviderSkillDescriptor>>>();
const ensuredSynaraSkillsDirs = new Set<string>();

export function invalidateSkillsCatalog(): void {
  skillsCatalogCache.clear();
  skillsCatalogInflight.clear();
  ensuredSynaraSkillsDirs.clear();
}

export const clearSkillsCatalogCacheForTests = invalidateSkillsCatalog;

export function synaraSkillsDir(synaraBaseDir: string): string {
  return nodePath.join(synaraBaseDir, "skills");
}

// Creates the portable skills folder on first use so users have a drop-in target.
export async function ensureSynaraSkillsDir(synaraBaseDir: string): Promise<string> {
  const dir = synaraSkillsDir(synaraBaseDir);
  if (ensuredSynaraSkillsDirs.has(dir)) {
    return dir;
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    ensuredSynaraSkillsDirs.add(dir);
  } catch {
    // Discovery still works without the folder; reads simply return nothing.
  }
  return dir;
}

type SkillsHomeOrigin = (typeof HOME_ORIGIN_ORDER)[number];

interface SkillOriginRootSpec {
  readonly homeRoots: (input: SkillsCatalogDiscoveryInput) => string[];
  readonly projectRootNames: readonly string[];
}

const SKILL_ORIGIN_ROOTS = {
  synara: {
    homeRoots: (input) => [synaraSkillsDir(input.synaraBaseDir)],
    projectRootNames: [".synara"],
  },
  codex: {
    // Keep Synara's existing Codex-local root. Official Codex discovery uses
    // `.agents/skills`, which is represented separately by the shared origin.
    homeRoots: (input) => [nodePath.join(input.homeDir, ".codex", "skills")],
    projectRootNames: [".codex"],
  },
  claude: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".claude", "skills")],
    projectRootNames: [".claude"],
  },
  cursor: {
    homeRoots: (input) => [
      nodePath.join(input.homeDir, ".cursor", "skills-cursor"),
      nodePath.join(input.homeDir, ".cursor", "skills"),
    ],
    projectRootNames: [".cursor"],
  },
  grok: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".grok", "skills")],
    projectRootNames: [".grok"],
  },
  factory: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".factory", "skills")],
    projectRootNames: [".factory"],
  },
  opencode: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".config", "opencode", "skills")],
    projectRootNames: [".opencode"],
  },
  pi: {
    homeRoots: (input) => [
      nodePath.join(input.agentDir ?? nodePath.join(input.homeDir, ".pi", "agent"), "skills"),
    ],
    projectRootNames: [".pi"],
  },
  devin: {
    homeRoots: (input) => [
      ...(process.platform === "win32"
        ? [
            nodePath.join(input.homeDir, "AppData", "Roaming", "devin", "skills"),
            nodePath.join(input.homeDir, "AppData", "Roaming", "cognition", "skills"),
          ]
        : []),
      nodePath.join(input.homeDir, ".config", "devin", "skills"),
      nodePath.join(input.homeDir, ".config", "cognition", "skills"),
      nodePath.join(input.homeDir, ".codeium", "windsurf", "skills"),
      nodePath.join(input.homeDir, ".codeium", "windsurf-next", "skills"),
      nodePath.join(input.homeDir, ".codeium", "windsurf-insiders", "skills"),
      // Keep the original path as a compatibility fallback for early Devin CLI builds.
      nodePath.join(input.homeDir, ".devin", "skills"),
    ],
    projectRootNames: [".devin", ".cognition", ".windsurf"],
  },
  omp: {
    homeRoots: (input) => [
      nodePath.join(input.agentDir ?? nodePath.join(input.homeDir, ".omp", "agent"), "skills"),
    ],
    projectRootNames: [".omp"],
  },
  codeg: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".codeg", "skills")],
    projectRootNames: [".codeg"],
  },
  antigravity: {
    homeRoots: (input) => [
      nodePath.join(input.homeDir, ".gemini", "config", "skills"),
      nodePath.join(input.homeDir, ".gemini", "antigravity-cli", "skills"),
      nodePath.join(input.homeDir, ".gemini", "antigravity", "skills"),
    ],
    projectRootNames: [],
  },
  copilot: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".copilot", "skills")],
    projectRootNames: [".github"],
  },
  auggie: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".augment", "skills")],
    projectRootNames: [".augment"],
  },
  junie: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".junie", "agent-skills")],
    projectRootNames: [],
  },
  gemini: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".gemini", "skills")],
    projectRootNames: [".gemini"],
  },
  goose: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".config", "goose", "skills")],
    projectRootNames: [],
  },
  agents: {
    homeRoots: (input) => [nodePath.join(input.homeDir, ".agents", "skills")],
    projectRootNames: [".agents"],
  },
} as const satisfies Record<SkillsHomeOrigin, SkillOriginRootSpec>;

const PROVIDER_SKILL_ORIGIN_PREFERENCES = {
  codex: ["codex", "agents"],
  claudeAgent: ["claude"],
  cursor: ["cursor", "agents", "claude", "codex"],
  antigravity: ["agents", "antigravity"],
  grok: ["grok", "claude", "agents"],
  droid: ["factory", "agents", "claude", "codex"],
  opencode: ["opencode", "claude", "agents"],
  pi: ["pi", "agents"],
  devin: ["devin", "claude", "agents"],
  omp: ["omp", "agents"],
} as const satisfies Partial<Record<ProviderKind, readonly SkillsHomeOrigin[]>>;

function homeRootsForOrigin(
  origin: SkillsHomeOrigin,
  input: SkillsCatalogDiscoveryInput,
): string[] {
  return SKILL_ORIGIN_ROOTS[origin].homeRoots(input);
}

function projectRootNamesForOrigin(origin: SkillsHomeOrigin): readonly string[] {
  return SKILL_ORIGIN_ROOTS[origin].projectRootNames;
}

// Native copies first so an agent keeps using its own skill, then Synara as the
// portable fallback, then the remaining provider homes for cross-provider reuse.
function preferredOriginsForProvider(
  provider: ProviderKind | null | undefined,
): ReadonlyArray<SkillsHomeOrigin> {
  return provider ? (PROVIDER_SKILL_ORIGIN_PREFERENCES[provider] ?? []) : [];
}

function orderedOriginsForProvider(
  provider: ProviderKind | null | undefined,
  includeSynaraRoot = true,
  includeRemainingOrigins = true,
): SkillsHomeOrigin[] {
  const preferred = preferredOriginsForProvider(provider);
  const ordered = [...preferred];
  if (includeSynaraRoot && !ordered.includes("synara")) {
    ordered.push("synara");
  }
  if (!includeRemainingOrigins) {
    return ordered.filter((origin) => includeSynaraRoot || origin !== "synara");
  }
  for (const origin of HOME_ORIGIN_ORDER) {
    if (!includeSynaraRoot && origin === "synara") {
      continue;
    }
    if (!ordered.includes(origin)) {
      ordered.push(origin);
    }
  }
  return ordered;
}

function rootsForOrderedOrigins(
  input: SkillsCatalogRootInput,
  orderedOrigins: ReadonlyArray<SkillsHomeOrigin>,
): SkillRoot[] {
  const homeRoots = orderedOrigins.flatMap((origin) =>
    homeRootsForOrigin(origin, input).map((path) =>
      origin === "pi" || origin === "omp"
        ? { path, scope: origin, includeMarkdownFiles: true }
        : { path, scope: origin },
    ),
  );
  const homeRootPaths = new Set(homeRoots.map((root) => nodePath.resolve(root.path)));

  const projectRoots: SkillRoot[] = [];
  const cwd = input.cwd?.trim();
  if (cwd) {
    for (const ancestor of ancestorsFromDeepest(cwd)) {
      const seenRootNames = new Set<string>();
      for (const origin of orderedOrigins) {
        for (const rootName of projectRootNamesForOrigin(origin)) {
          if (seenRootNames.has(rootName)) {
            continue;
          }
          seenRootNames.add(rootName);
          const rootPath = nodePath.join(ancestor, rootName, "skills");
          // A cwd under the home dir reaches the home skill folders as
          // "project ancestors"; skip them here so each folder is scanned once
          // and keeps its true origin scope. Precedence is unchanged because
          // project and home roots share the same origin ordering.
          if (homeRootPaths.has(nodePath.resolve(rootPath))) {
            continue;
          }
          projectRoots.push(
            origin === "pi" || origin === "omp"
              ? { path: rootPath, scope: "project", includeMarkdownFiles: true }
              : { path: rootPath, scope: "project" },
          );
        }
      }
    }
  }

  return [...projectRoots, ...homeRoots];
}

export function skillsCatalogRoots(input: SkillsCatalogRootInput): SkillRoot[] {
  return rootsForOrderedOrigins(
    input,
    orderedOriginsForProvider(input.provider, input.includeSynaraRoot !== false),
  );
}

export function providerNativeSkillRoots(input: SkillsCatalogRootInput): SkillRoot[] {
  return rootsForOrderedOrigins(input, orderedOriginsForProvider(input.provider, false, false));
}

export async function bindManagedSkillDescriptors(
  skills: readonly ProviderSkillDescriptor[],
  homeDir: string,
  includeDisabled = false,
): Promise<ProviderSkillDescriptor[]> {
  let registry: {
    resources?: Array<{
      id: string;
      kind?: string;
      source: string;
      name?: string;
      enabled: boolean;
      ownership: string;
    }>;
  };
  try {
    registry = JSON.parse(await fs.readFile(nodePath.join(homeDir, ".agents/setup.json"), "utf8"));
  } catch {
    return [...skills];
  }
  const deployments: Array<{ path: string; resourceId: string }> = await fs
    .readFile(nodePath.join(homeDir, ".agents/.state/deployments.json"), "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => []);
  const bindings = new Map<
    string,
    { id: string; enabled: boolean; ownership: string; descriptor: ProviderSkillDescriptor | null }
  >();
  for (const resource of registry.resources ?? []) {
    if (resource.ownership === "archive" || (resource.kind && resource.kind !== "skill")) continue;
    const source = resource.source.startsWith("~/")
      ? nodePath.join(homeDir, resource.source.slice(2))
      : resource.source;
    const skillPath = nodePath.join(source, "SKILL.md");
    const descriptor = resource.ownership.startsWith("managed")
      ? await readSkillDescriptor({ skillPath, scope: "agents" })
      : null;
    const binding = {
      id: resource.id,
      enabled: resource.enabled,
      ownership: resource.ownership,
      descriptor,
    };
    bindings.set(await fs.realpath(skillPath).catch(() => source), binding);
    for (const deployment of deployments.filter(
      (deployment) => deployment.resourceId === resource.id,
    )) {
      bindings.set(
        await fs.realpath(nodePath.join(deployment.path, "SKILL.md")).catch(() => ""),
        binding,
      );
    }
  }
  const result: ProviderSkillDescriptor[] = [];
  for (const skill of skills) {
    const canonicalPath =
      skill.canonicalPath ?? (await fs.realpath(skill.path).catch(() => skill.path));
    const binding = bindings.get(canonicalPath);
    if (binding && !binding.enabled && !includeDisabled) continue;
    const source = binding?.descriptor;
    result.push(
      binding && source && binding.ownership.startsWith("managed")
        ? {
            ...source,
            resourceId: binding.id,
            path: source.canonicalPath ?? source.path,
            ownership: binding.ownership.startsWith("managed") ? "managed-shared" : "external",
            enabled: binding.enabled && source.enabled,
            ...(binding.ownership.startsWith("managed") && source.packageHash !== skill.packageHash
              ? {
                  diagnostics: [
                    "Canonical source differs from the native export; review the pending reconciliation.",
                  ],
                }
              : {}),
          }
        : {
            ...skill,
            canonicalPath,
            ...(binding
              ? {
                  resourceId: binding.id,
                  ownership: "external",
                  enabled: binding.enabled && skill.enabled,
                }
              : {}),
          },
    );
  }
  return result;
}

export async function discoverSkillsCatalog(
  input: SkillsCatalogDiscoveryInput,
): Promise<ProviderSkillDescriptor[]> {
  const cacheKey = [
    input.cwd?.trim() ?? "",
    input.provider ?? "",
    input.homeDir,
    input.synaraBaseDir,
    input.agentDir?.trim() ?? "",
    input.includeDuplicateOrigins ? "all-origins" : "deduped",
  ].join("\u0000");

  if (!input.forceReload) {
    const entry = skillsCatalogCache.get(cacheKey);
    if (entry && Date.now() - entry.at <= SKILLS_CATALOG_CACHE_TTL_MS) {
      return [...entry.skills];
    }
  }

  const inflight = skillsCatalogInflight.get(cacheKey);
  if (inflight) {
    return [...(await inflight)];
  }

  const scan = (async () => {
    await ensureSynaraSkillsDir(input.synaraBaseDir);
    const roots = [
      ...skillsCatalogRoots(input),
      ...(await discoverClaudePluginSkillRoots({
        homeDir: input.homeDir,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      })),
    ];
    let skills = await collectSkillDescriptorsFromRoots(roots);
    skills = await bindManagedSkillDescriptors(
      skills,
      input.homeDir,
      input.includeDuplicateOrigins ?? false,
    );
    skills = mergeSkillsIntoCatalog({ native: [], catalog: skills });

    skillsCatalogCache.delete(cacheKey);
    skillsCatalogCache.set(cacheKey, { at: Date.now(), skills });
    while (skillsCatalogCache.size > SKILLS_CATALOG_CACHE_MAX_ENTRIES) {
      const oldestKey = skillsCatalogCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      skillsCatalogCache.delete(oldestKey);
    }
    return skills;
  })();

  skillsCatalogInflight.set(cacheKey, scan);
  try {
    return [...(await scan)];
  } finally {
    skillsCatalogInflight.delete(cacheKey);
  }
}

// Preserve distinct same-name resources; collapse aliases of one managed identity.
export function mergeSkillsIntoCatalog(input: {
  readonly native: ReadonlyArray<ProviderSkillDescriptor>;
  readonly catalog: ReadonlyArray<ProviderSkillDescriptor>;
}): ProviderSkillDescriptor[] {
  const byIdentity = new Map<string, ProviderSkillDescriptor>();
  // Managed shared references resolve to their canonical source independently of the model.
  const all = [
    ...input.catalog.filter((skill) => skill.ownership === "managed-shared"),
    ...input.native,
    ...input.catalog,
  ];
  for (const skill of all) {
    const binding = input.catalog.find(
      (item) =>
        item.ownership === "managed-shared" &&
        (item.canonicalPath === skill.canonicalPath || item.path === skill.path),
    );
    const key = binding?.resourceId ?? skill.resourceId ?? skill.canonicalPath ?? skill.path;
    if (!byIdentity.has(key)) byIdentity.set(key, skill);
  }
  const skills = [...byIdentity.values()];
  return skills.map((skill) => {
    const conflicts = skills.filter(
      (other) =>
        other !== skill &&
        skillNameKey(other.name) === skillNameKey(skill.name) &&
        other.packageHash !== skill.packageHash,
    );
    return conflicts.length
      ? {
          ...skill,
          diagnostics: [
            `Same-name resources have different or unverified package contents: ${conflicts.map((other) => other.path).join(", ")}`,
          ],
        }
      : skill;
  });
}

export function filterDisabledSkills(
  skills: ReadonlyArray<ProviderSkillDescriptor>,
  disabledNames: ReadonlyArray<string>,
): ProviderSkillDescriptor[] {
  if (disabledNames.length === 0) {
    return [...skills];
  }
  const disabled = new Set(disabledNames.map((name) => skillNameKey(name)));
  return skills.filter(
    (skill) =>
      !disabled.has(skillNameKey(skill.name)) &&
      !disabled.has(skillNameKey(skill.resourceId ?? "")),
  );
}
