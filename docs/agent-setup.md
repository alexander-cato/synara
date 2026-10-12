# Portable agent setup

Settings → **Agent setup** manages personal sources in `~/.agents`. The existing `/settings?section=skills` link and skill-discovery APIs remain compatible. Repository `AGENTS.md` files and scoped rules retain repository ownership. Memories, authentication, selected models, permissions, sandbox configuration, and installer-owned packages are outside reconciliation.

```text
~/.agents/
  AGENTS.md
  setup.json
  catalog/skills/<name>/SKILL.md
  catalog/roles/<name>.json
  catalog/rules/
  integrations/
  skills/                  # Generated package copies
  archive/                 # Retired originals; excluded from discovery
  .state/                  # Private inventory, deployments, journals and backups
```

Keep instructions, catalog sources, integration definitions, and `setup.json` in local Git. Exclude `skills`, `archive`, `.state`, and installer lock files. Reconciliation never creates a remote or publishes cloud resources.

## Sources and ownership

Skills use the [Agent Skills package format](https://agentskills.io/specification): `SKILL.md` with optional scripts, references, and assets. The registry stores management metadata separately. Package fingerprints include every file's bytes, relative path, size, and executable bits; identical manifests with different scripts are separate packages.

Each resource has a stable ID and a disposition: managed shared source, managed integration, external client-owned resource, generated output, or archive. External same-name variants remain separate and read-only. The editor shows every loaded/exported copy, differences, requirements, and unavailable features. Project locations and migration provenance are machine state, rather than portable policy.

Native shared discovery uses generated package copies under `~/.agents/skills`. Clients needing their own locations receive individual links to those copies. Editing a catalog package creates a pending difference; clients receive it after reconciliation. A disabled managed skill remains editable but has no native export. Disabling an external skill in Synara controls its picker visibility; its installer or native client controls native enablement.

## Review and apply

1. Edit the catalog, personal instructions, a role, or the registry through the editor or your usual tools. Editor saves require the revision that was opened.
2. Select **Preview changes**. Review the ordered operations, file/package diffs, conflicts, and restart requirements.
3. Select **Apply this preview**. A changed source, export, native configuration, or binding invalidates the preview. Apply refuses stale revisions and produces a fresh diff.

The standalone `synara-agent-setup` command uses the same engine:

```sh
synara-agent-setup inventory
synara-agent-setup read --id skill:example
synara-agent-setup preview
synara-agent-setup apply --revision <exact-preview-revision>
synara-agent-setup verify --client codex
synara-agent-setup rollback --backup-id <journal-id>
```

During development, use `bun run apps/server/src/agentSetupCli.ts` from the checkout. `--home-dir <fixture-home>` selects a disposable personal setup for isolated tests. `save` takes `--id`, `--file`, `--expected-revision`, and `--content-file`; it updates the editable source and leaves deployment pending.

Watchers invalidate discovery when files change; they never overwrite files. Apply holds a shared reconciliation lock, stages package copies, writes durable undo information before each mutation, and records completed operations. Backups and native configuration diffs live under permission-restricted `.state`. A failed/interrupted apply must be recovered through rollback before another apply. Rollback refuses later edits that would otherwise be lost and retains unrelated deployment records. Native JSON/JSONC/TOML conversion edits only declared fields; malformed or unsupported conversions produce conflicts.

## Models, roles, and capabilities

Shared resources have no model selector. Portable roles use `model: "inherit"` and semantic requirements such as filesystem reading or shell access. Adapters translate supported requirements into native tools. Explicit overrides carry a client, requested model, rationale, and review date; an unverified override is refused instead of substituted.

Generic Claude roles inherit the current model. Explicit Codex model mentions are checked against current discovery; unavailable requests fail. Personal registry deny selectors apply to session starts and turn dispatch across Synara providers. Native clients also receive the personal policy through their supported instruction locations. Effort and host-specific features remain capability-dependent.

## Client status and limitations

Adapters report instructions, skills, roles, MCP, hooks, and disablement separately. Missing runtimes remain unverified and are never installed automatically. Version detection or matching files does not prove instruction injection. `verify` uses bounded metadata-only probes in temporary fixtures, never submits a model prompt, and checks the installed Claude CLI separately from the bundled SDK. Evidence becomes stale after source, output, binding, or runtime changes.

Supported exports include Codex and Cursor shared skills, per-package Claude links, OpenCode instruction references, Copilot CLI instructions, Auggie personal rules, separate Antigravity desktop/CLI skill locations, Grok additional skill paths, and Junie global skills/instructions. Other configured clients remain visible with explicit manual limitations. IDE loading, local CLI loading, and cloud synchronization are separate capabilities.

Orca registrations, Browserclaw integrations, account-synced packages, bundled skills, plugin caches, and Synara's session gateway retain their native ownership. User-owned integration definitions and script sources can live in the portable catalog, but unsupported MCP/hook formats are not generated. Session credentials never belong in portable sources.

## Validation

The affected tests cover complete-package equality, nested synced discovery, archive aliases, cycles and broken links, stable external identity, enablement and legacy names, frozen exports, idempotence, concurrent edits, interrupted journals, rollback, configuration preservation, inherited roles, and model restrictions. Settings rendering tests cover divergent copies, ownership, archives, recovery diagnostics, and management views. Live client loading and platform-specific behavior require their own evidence; unit tests do not establish them.
