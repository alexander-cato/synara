import { Schema } from "effect";
import { TrimmedNonEmptyString as Text } from "./baseSchemas";

export const AgentResourceKind = Schema.Literals([
  "skill",
  "instructions",
  "role",
  "rule",
  "mcp",
  "hook",
  "integration",
  "registry",
]);
export const AgentOwnership = Schema.Literals([
  "managed-shared",
  "managed-integration",
  "external",
  "generated",
  "archive",
]);
export const AgentRequirement = Schema.Struct({
  capability: Text,
  rationale: Text,
});
export const AgentTargetingException = Schema.Struct({
  selector: Text,
  rationale: Text,
  reviewDate: Text,
  effect: Schema.Literals(["require", "deny"]),
});
export const AgentUpstreamReference = Schema.Struct({
  path: Text,
  owner: Text,
  revision: Schema.optional(Text),
  url: Schema.optional(Text),
});
export const AgentResourceRegistration = Schema.Struct({
  id: Text,
  name: Text,
  kind: AgentResourceKind,
  source: Text,
  ownership: AgentOwnership,
  enabled: Schema.Boolean,
  requirements: Schema.Array(AgentRequirement),
  aliases: Schema.Array(Text),
  upstream: Schema.Array(AgentUpstreamReference),
  targetingExceptions: Schema.Array(AgentTargetingException),
});
export type AgentResourceRegistration = typeof AgentResourceRegistration.Type;

export const AgentFeatureSupport = Schema.Struct({
  feature: Schema.Literals(["instructions", "skills", "roles", "mcp", "hooks", "disablement"]),
  support: Schema.Literals(["native", "generated", "manual", "unsupported"]),
  limitation: Schema.optional(Text),
});
export const AgentClientBinding = Schema.Struct({
  id: Text,
  name: Text,
  executable: Schema.optional(Text),
  configured: Schema.Boolean,
  skillDelivery: Schema.Literals(["shared", "links", "manual"]),
  skillRoots: Schema.Array(Text),
  skillTarget: Schema.optional(Text),
  instructionTarget: Schema.optional(Text),
  instructionFormat: Schema.optional(Schema.Literals(["copy", "import"])),
  instructionConfig: Schema.optional(
    Schema.Struct({
      path: Text,
      format: Schema.Literals(["json", "jsonc", "toml"]),
      field: Schema.Array(Text),
    }),
  ),
  skillConfig: Schema.optional(
    Schema.Struct({
      path: Text,
      format: Schema.Literals(["json", "jsonc", "toml"]),
      field: Schema.Array(Text),
    }),
  ),
  capabilities: Schema.Array(Text),
  features: Schema.Array(AgentFeatureSupport),
});
export type AgentClientBinding = typeof AgentClientBinding.Type;

export const AgentSetupManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  resources: Schema.Array(AgentResourceRegistration),
  clients: Schema.Array(AgentClientBinding),
  inventoryRoots: Schema.Array(Schema.Struct({ path: Text, owner: Text })),
  targetingExceptions: Schema.Array(AgentTargetingException),
});
export type AgentSetupManifest = typeof AgentSetupManifest.Type;

export const AgentRoleDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Text,
  description: Text,
  instructions: Text,
  requirements: Schema.Array(AgentRequirement),
  model: Schema.Literal("inherit"),
  overrides: Schema.Array(
    Schema.Struct({ client: Text, model: Text, rationale: Text, reviewDate: Text }),
  ),
});
export type AgentRoleDefinition = typeof AgentRoleDefinition.Type;

export const AgentResourceCopy = Schema.Struct({
  path: Text,
  canonicalPath: Text,
  packageHash: Text,
  ownership: AgentOwnership,
  owner: Text,
  relation: Schema.Literals(["source", "identical", "divergent", "export", "archive"]),
});
export type AgentResourceCopy = typeof AgentResourceCopy.Type;
export const AgentResourceDescriptor = Schema.Struct({
  ...AgentResourceRegistration.fields,
  packageHash: Text,
  revision: Text,
  copies: Schema.Array(AgentResourceCopy),
  files: Schema.Array(Text),
  diagnostics: Schema.Array(Text),
});
export type AgentResourceDescriptor = typeof AgentResourceDescriptor.Type;

export const AgentClientStatus = Schema.Struct({
  id: Text,
  name: Text,
  configured: Schema.Boolean,
  runtimePath: Schema.optional(Text),
  features: Schema.Array(AgentFeatureSupport),
  effectiveResources: Schema.Array(Text),
  unavailableResources: Schema.Array(Schema.Struct({ id: Text, reason: Text })),
  verification: Schema.Literals(["unverified", "verified", "limited"]),
  diagnostics: Schema.Array(Text),
});
export type AgentClientStatus = typeof AgentClientStatus.Type;

export const AgentReconcileOperation = Schema.Struct({
  id: Text,
  resourceId: Text,
  clientId: Text,
  kind: Schema.Literals(["write", "link", "remove", "package"]),
  source: Schema.optional(Text),
  sourceRevision: Schema.optional(Text),
  path: Text,
  expectedRevision: Text,
  before: Schema.String,
  after: Schema.String,
  restart: Schema.Boolean,
});
export type AgentReconcileOperation = typeof AgentReconcileOperation.Type;
export const AgentReconcilePlan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Text,
  inventoryRevision: Text,
  sourceRevisions: Schema.Record(Text, Text),
  operations: Schema.Array(AgentReconcileOperation),
  conflicts: Schema.Array(Text),
});
export type AgentReconcilePlan = typeof AgentReconcilePlan.Type;
export const AgentApplyResult = Schema.Struct({
  planRevision: Text,
  completed: Schema.Array(Text),
  failures: Schema.Array(Text),
  backupReferences: Schema.Array(Text),
  restartClients: Schema.Array(Text),
});
export type AgentApplyResult = typeof AgentApplyResult.Type;
export const AgentSetupInventory = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Text,
  manifestRevision: Text,
  sourceRoot: Text,
  resources: Schema.Array(AgentResourceDescriptor),
  clients: Schema.Array(AgentClientStatus),
  diagnostics: Schema.Array(Text),
  history: Schema.Array(Schema.Struct({ id: Text, createdAt: Text, status: Text })),
});
export type AgentSetupInventory = typeof AgentSetupInventory.Type;

export const AgentSetupInventoryInput = Schema.Struct({});
export const AgentResourceReadInput = Schema.Struct({ id: Text, file: Schema.optional(Text) });
export const AgentResourceReadResult = Schema.Struct({
  id: Text,
  file: Text,
  revision: Text,
  content: Schema.String,
  editable: Schema.Boolean,
});
export type AgentResourceReadResult = typeof AgentResourceReadResult.Type;
export const AgentResourceSaveInput = Schema.Struct({
  id: Text,
  file: Text,
  expectedRevision: Text,
  content: Schema.String,
});
export const AgentReconcileApplyInput = Schema.Struct({ revision: Text });
export const AgentRollbackInput = Schema.Struct({ backupId: Text });
