import type {
  AgentReconcilePlan,
  AgentResourceDescriptor,
  AgentResourceReadResult,
  AgentSetupManifest,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useState } from "react";
import { CodeEditorPane } from "~/components/codeEditor/CodeEditorPane";
import { CodeDiffEditorPane } from "~/components/codeEditor/CodeDiffEditorPane";
import { SettingsRow, SettingsSection } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useTheme } from "~/hooks/useTheme";
import { ensureNativeApi } from "~/nativeApi";
import { providerDiscoveryQueryKeys } from "~/lib/providerDiscoveryReactQuery";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";

const inventoryKey = ["agent-setup", "inventory"] as const;
const tabs = [
  "Resources",
  "Instructions",
  "Roles",
  "Integrations",
  "Clients",
  "Pending",
  "History",
] as const;
type Tab = (typeof tabs)[number];

// Retain the old component/route name so existing skills deep links remain valid.
function useAgentSetupController() {
  const queryClient = useQueryClient();
  const inventoryQuery = useQuery({
    queryKey: inventoryKey,
    queryFn: () => ensureNativeApi().agentSetup.inventory({}),
    refetchInterval: 5000,
  });
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const { resolvedTheme } = useTheme();
  const [tab, setTab] = useState<Tab>("Resources");
  const [opened, setOpened] = useState<AgentResourceReadResult | null>(null);
  const [draft, setDraft] = useState("");
  const [version, setVersion] = useState(0);
  const [plan, setPlan] = useState<AgentReconcilePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const dirty = opened !== null && opened.content !== draft;
  useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: () => dirty });
  const inventory = inventoryQuery.data;
  const disabled = new Set(settingsQuery.data?.skills.disabled ?? []);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: inventoryKey });
    await queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
  };
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    return operation()
      .then(refresh)
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  };
  const open = (id: string, file?: string) => {
    if (dirty) {
      setMessage("Save or discard the current draft before opening another source.");
      return;
    }
    void perform(async () => {
      const result = await ensureNativeApi().agentSetup.readResource({
        id,
        ...(file ? { file } : {}),
      });
      setOpened(result);
      setDraft(result.content);
      setVersion((current) => current + 1);
    });
  };
  const save = () => {
    if (!opened || !dirty || !opened.editable) return;
    void perform(async () => {
      const result = await ensureNativeApi().agentSetup.saveResource({
        ...opened,
        content: draft,
        expectedRevision: opened.revision,
      });
      setOpened(result);
      setPlan(null);
      setMessage("Source saved. Preview reconciliation to update client exports.");
    });
  };
  const setEnabled = (resource: AgentResourceDescriptor, enabled: boolean) => {
    void perform(async () => {
      const api = ensureNativeApi();
      if (resource.ownership.startsWith("managed")) {
        if (enabled) {
          const settings = await api.server.getSettings();
          const keys = new Set(
            [resource.name, resource.id, ...resource.aliases].map((key) => key.toLowerCase()),
          );
          const next = settings.skills.disabled.filter((key) => !keys.has(key.toLowerCase()));
          if (next.length !== settings.skills.disabled.length) {
            queryClient.setQueryData(
              serverQueryKeys.settings(),
              await api.server.updateSettings({ skills: { disabled: next } }),
            );
          }
        }
        const registry = await api.agentSetup.readResource({ id: "agent-setup-registry" });
        const manifest = JSON.parse(registry.content) as AgentSetupManifest;
        await api.agentSetup.saveResource({
          id: registry.id,
          file: registry.file,
          expectedRevision: registry.revision,
          content: `${JSON.stringify({ ...manifest, resources: manifest.resources.map((item) => (item.id === resource.id ? { ...item, enabled } : item)) }, null, 2)}\n`,
        });
        setPlan(null);
        setMessage("Enablement saved. Apply a preview to change native discovery.");
      } else {
        // Legacy names remain compatible. This only controls Synara's picker.
        const names = new Set((await api.server.getSettings()).skills.disabled);
        if (enabled) {
          const keys = new Set(
            [resource.name, ...resource.aliases].map((key) => key.toLowerCase()),
          );
          const legacy = [...names].filter((name) => keys.has(name.toLowerCase()));
          if (legacy.length) {
            for (const other of inventory?.resources ?? [])
              if (
                other.kind === "skill" &&
                other.id !== resource.id &&
                keys.has(other.name.toLowerCase())
              )
                names.add(other.id);
            for (const name of legacy) names.delete(name);
          }
          names.delete(resource.id);
        } else names.add(resource.id);
        const settings = await api.server.updateSettings({
          skills: { disabled: [...names].toSorted() },
        });
        queryClient.setQueryData(serverQueryKeys.settings(), settings);
        setMessage(
          "Synara visibility changed. This client-owned resource keeps its native enablement.",
        );
      }
    });
  };
  const resources =
    inventory?.resources.filter((resource) =>
      tab === "Resources"
        ? resource.kind === "skill"
        : tab === "Instructions"
          ? ["instructions", "rule", "registry"].includes(resource.kind)
          : tab === "Roles"
            ? resource.kind === "role"
            : tab === "Integrations"
              ? ["mcp", "hook", "integration"].includes(resource.kind)
              : false,
    ) ?? [];
  const selected = inventory?.resources.find((resource) => resource.id === opened?.id);

  return {
    inventoryQuery,
    inventory,
    tab,
    setTab,
    opened,
    setOpened,
    draft,
    setDraft,
    version,
    setVersion,
    plan,
    setPlan,
    busy,
    message,
    setMessage,
    dirty,
    disabled,
    resources,
    selected,
    resolvedTheme,
    perform,
    open,
    save,
    setEnabled,
  };
}

type SetupController = ReturnType<typeof useAgentSetupController>;

export function SkillsSettingsPanel() {
  const controller = useAgentSetupController();
  const { inventoryQuery, inventory, tab, setTab, opened, busy, message, setPlan, perform } =
    controller;
  return (
    <div className="space-y-6">
      <SettingsSection title="Agent setup">
        <SettingsRow
          title="Personal source"
          description="Edit portable files, then review and apply client exports. Model restrictions and client-owned resources stay visible."
          status={
            <code className="text-ui-sm break-all text-muted-foreground">
              {inventory?.sourceRoot ?? "~/.agents"}
            </code>
          }
          control={
            <Button
              disabled={busy}
              onClick={() => {
                void perform(async () => {
                  setPlan(await ensureNativeApi().agentSetup.preview({}));
                  setTab("Pending");
                });
              }}
            >
              Preview changes
            </Button>
          }
        />
      </SettingsSection>
      <nav aria-label="Agent setup views" className="flex flex-wrap gap-2">
        {tabs.map((name) => (
          <Button
            key={name}
            variant={tab === name ? "default" : "outline"}
            onClick={() => setTab(name)}
          >
            {name}
          </Button>
        ))}
      </nav>
      <div role="status" aria-live="polite" className="text-ui text-muted-foreground">
        {busy ? "Working…" : message}
      </div>
      {inventoryQuery.isLoading ? <p className="text-ui">Scanning agent resources…</p> : null}
      {inventoryQuery.isError ? (
        <p role="alert" className="text-ui text-destructive">
          {String(inventoryQuery.error)}
        </p>
      ) : null}
      {inventory?.diagnostics.map((diagnostic) => (
        <p key={diagnostic} className="text-ui text-muted-foreground">
          {diagnostic}
        </p>
      ))}
      <AgentResourceList controller={controller} />
      {opened ? <AgentSourceEditor controller={controller} /> : null}
      {tab === "Clients" ? <AgentClientList controller={controller} /> : null}
      {tab === "Pending" ? <AgentPendingPlan controller={controller} /> : null}
      {tab === "History" ? <AgentRollbackHistory controller={controller} /> : null}
    </div>
  );
}

function AgentResourceList({ controller }: { controller: SetupController }) {
  const { resources, tab, busy, disabled, open, setEnabled } = controller;
  const [search, setSearch] = useState("");
  const [ownership, setOwnership] = useState("all");
  const visible = resources.filter(
    (resource) =>
      (ownership === "all" || resource.ownership === ownership) &&
      `${resource.name} ${resource.id} ${resource.source}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      {resources.length ? (
        <SettingsSection title={tab}>
          <div className="flex flex-wrap items-center gap-3 border-b p-4">
            <input
              aria-label="Search agent resources"
              placeholder="Search names or paths"
              className="min-w-48 flex-1 rounded border bg-background p-2 text-ui"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="Resource ownership"
              className="rounded border bg-background p-2 text-ui"
              value={ownership}
              onChange={(event) => setOwnership(event.target.value)}
            >
              <option value="all">All ownership</option>
              <option value="managed-shared">Managed shared</option>
              <option value="managed-integration">Managed integrations</option>
              <option value="external">Client-owned</option>
              <option value="archive">Archived</option>
            </select>
            <span className="text-ui-sm text-muted-foreground">
              {visible.length} of {resources.length} resources
            </span>
          </div>
          {visible.map((resource) => (
            <SettingsRow
              key={resource.id}
              title={resource.name}
              description={`${resource.kind} · ${resource.ownership} · ${resource.packageHash.slice(0, 12)}`}
              status={
                <div className="space-y-1 text-ui-sm text-muted-foreground">
                  <code className="block break-all">{resource.source}</code>
                  {resource.requirements.map((requirement) => (
                    <p key={requirement.capability}>
                      {requirement.capability}: {requirement.rationale}
                    </p>
                  ))}
                  {resource.targetingExceptions.map((exception) => (
                    <p key={exception.selector}>
                      {exception.effect} {exception.selector}: {exception.rationale} (review{" "}
                      {exception.reviewDate})
                    </p>
                  ))}
                  {resource.copies.map((copy) => (
                    <p
                      key={copy.path}
                      className={
                        copy.relation === "divergent" ? "text-amber-600 dark:text-amber-400" : ""
                      }
                    >
                      {copy.relation} · {copy.owner} ·{" "}
                      <code className="break-all">{copy.path}</code> ·{" "}
                      {copy.packageHash.slice(0, 12)}
                    </p>
                  ))}
                  {resource.diagnostics.map((diagnostic) => (
                    <p key={diagnostic}>{diagnostic}</p>
                  ))}
                </div>
              }
              control={
                <div className="flex items-center gap-3">
                  <Button variant="outline" disabled={busy} onClick={() => open(resource.id)}>
                    {resource.ownership.startsWith("managed") ? "Edit source" : "Read source"}
                  </Button>
                  {resource.kind === "skill" ? (
                    <Switch
                      disabled={busy || resource.ownership === "archive"}
                      checked={
                        resource.enabled &&
                        !disabled.has(resource.name) &&
                        !disabled.has(resource.id)
                      }
                      aria-label={`${resource.ownership.startsWith("managed") ? "Export" : "Show in Synara"} ${resource.name}`}
                      onCheckedChange={(checked) => setEnabled(resource, Boolean(checked))}
                    />
                  ) : null}
                </div>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function AgentSourceEditor({ controller }: { controller: SetupController }) {
  const [newFile, setNewFile] = useState("");
  const {
    opened,
    selected,
    busy,
    dirty,
    draft,
    version,
    resolvedTheme,
    setDraft,
    setVersion,
    setOpened,
    open,
    save,
  } = controller;
  return (
    <>
      {opened ? (
        <SettingsSection
          title={`${opened.editable ? "Edit" : "Read"} ${selected?.name ?? opened.id}`}
        >
          <div className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Resource file"
                className="max-w-full rounded border bg-background p-2 text-ui"
                value={opened.file}
                disabled={busy || dirty}
                onChange={(event) => open(opened.id, event.target.value)}
              >
                {[...new Set([opened.file, ...(selected?.files ?? [])])].map((file) => (
                  <option key={file} value={file}>
                    {file}
                  </option>
                ))}
              </select>
              {opened.editable && selected?.kind === "skill" ? (
                <>
                  <input
                    aria-label="New package file"
                    placeholder="scripts/example.sh"
                    className="rounded border bg-background p-2 text-ui"
                    value={newFile}
                    onChange={(event) => setNewFile(event.target.value)}
                    disabled={busy || dirty}
                  />
                  <Button
                    variant="outline"
                    disabled={busy || dirty || !newFile.trim()}
                    onClick={() => {
                      open(opened.id, newFile.trim());
                      setNewFile("");
                    }}
                  >
                    Add file
                  </Button>
                </>
              ) : null}
              <Button disabled={busy || !dirty || !opened.editable} onClick={save}>
                Save source
              </Button>
              <Button
                variant="outline"
                disabled={busy || !dirty}
                onClick={() => {
                  setDraft(opened.content);
                  setVersion((current) => current + 1);
                }}
              >
                Discard draft
              </Button>
              <Button variant="ghost" disabled={dirty || busy} onClick={() => setOpened(null)}>
                Close
              </Button>
            </div>
            <div className="flex h-96 min-h-0 overflow-hidden rounded border">
              {opened.editable ? (
                <CodeEditorPane
                  fileName={opened.file}
                  value={draft}
                  valueVersion={version}
                  resolvedTheme={resolvedTheme}
                  onChange={setDraft}
                  onSave={save}
                />
              ) : (
                <CodeDiffEditorPane
                  fileName={opened.file}
                  original={opened.content}
                  modified={opened.content}
                  originalVersion={version}
                  modifiedVersion={version}
                  resolvedTheme={resolvedTheme}
                  renderSideBySide={false}
                  readOnly
                  onChange={() => {}}
                  onSave={() => {}}
                />
              )}
            </div>
            {dirty ? (
              <p className="text-ui-sm text-muted-foreground">
                Unsaved draft. Navigation is held until you save or discard it.
              </p>
            ) : null}
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}

function AgentClientList({ controller }: { controller: SetupController }) {
  const { inventory, tab } = controller;
  return (
    <>
      {tab === "Clients" ? (
        <SettingsSection title="Client status">
          {inventory?.clients.map((client) => (
            <SettingsRow
              key={client.id}
              title={client.name}
              description={`${client.verification} · ${client.runtimePath ?? "Runtime unavailable"}`}
              status={
                <div className="space-y-1 text-ui-sm text-muted-foreground">
                  {client.features.map((feature) => (
                    <p key={feature.feature}>
                      {feature.feature}: {feature.support}
                      {feature.limitation ? ` · ${feature.limitation}` : ""}
                    </p>
                  ))}
                  {client.unavailableResources.map((resource) => (
                    <p key={resource.id}>
                      {resource.id}: {resource.reason}
                    </p>
                  ))}
                  {client.diagnostics.map((diagnostic) => (
                    <p key={diagnostic}>{diagnostic}</p>
                  ))}
                </div>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function AgentPendingPlan({ controller }: { controller: SetupController }) {
  const { plan, tab, busy, dirty, perform, setMessage, setPlan, resolvedTheme } = controller;
  return (
    <>
      {tab === "Pending" ? (
        <div className="space-y-4">
          {plan ? (
            <>
              <p className="text-ui">
                {plan.operations.length} pending operations · preview {plan.revision.slice(0, 12)}
              </p>
              {plan.conflicts.map((conflict) => (
                <p key={conflict} role="alert" className="text-ui text-destructive">
                  {conflict}
                </p>
              ))}
              <Button
                disabled={
                  busy || dirty || plan.conflicts.length > 0 || plan.operations.length === 0
                }
                onClick={() => {
                  void perform(async () => {
                    const result = await ensureNativeApi().agentSetup.apply({
                      revision: plan.revision,
                    });
                    setMessage(
                      result.failures.length
                        ? result.failures.join("; ")
                        : `${result.completed.length} operations applied. ${result.restartClients.length ? `Restart sessions for ${result.restartClients.join(", ")} to load the changes.` : "New discovery uses the exports immediately."}`,
                    );
                    setPlan(await ensureNativeApi().agentSetup.preview({}));
                  });
                }}
              >
                Apply this preview
              </Button>
              {plan.operations.map((operation) => (
                <SettingsSection
                  key={operation.id}
                  title={`${operation.kind} · ${operation.clientId}`}
                >
                  <div className="space-y-2 p-4">
                    <code className="break-all text-ui-sm">{operation.path}</code>
                    <p className="text-ui-sm text-muted-foreground">
                      {operation.restart
                        ? "Restart existing sessions after applying."
                        : "New discovery sees this change immediately."}
                    </p>
                    <div className="flex h-64 overflow-hidden rounded border">
                      <CodeDiffEditorPane
                        fileName={operation.path}
                        original={operation.before}
                        modified={operation.after}
                        originalVersion={0}
                        modifiedVersion={0}
                        resolvedTheme={resolvedTheme}
                        renderSideBySide
                        readOnly
                        onChange={() => {}}
                        onSave={() => {}}
                      />
                    </div>
                  </div>
                </SettingsSection>
              ))}
            </>
          ) : (
            <p className="text-ui text-muted-foreground">
              Preview changes to review export diffs. Drift is detected without overwriting files.
            </p>
          )}
        </div>
      ) : null}
    </>
  );
}

function AgentRollbackHistory({ controller }: { controller: SetupController }) {
  const { inventory, tab, busy, dirty, perform, setMessage, setPlan } = controller;
  return (
    <>
      {tab === "History" ? (
        <SettingsSection title="Rollback history">
          {inventory?.history.length ? (
            inventory.history.map((entry) => (
              <SettingsRow
                key={entry.id}
                title={entry.createdAt}
                description={`${entry.status} · ${entry.id}`}
                control={
                  <Button
                    variant="outline"
                    disabled={busy || dirty || entry.status === "rolled-back"}
                    onClick={() => {
                      void perform(async () => {
                        const result = await ensureNativeApi().agentSetup.rollback({
                          backupId: entry.id,
                        });
                        setPlan(null);
                        setMessage(
                          `Rolled back ${result.completed.length} operations. Later external edits are preserved.`,
                        );
                      });
                    }}
                  >
                    Roll back
                  </Button>
                }
              />
            ))
          ) : (
            <p className="p-4 text-ui text-muted-foreground">
              No reconciliation or source-save backups yet.
            </p>
          )}
        </SettingsSection>
      ) : null}
    </>
  );
}
