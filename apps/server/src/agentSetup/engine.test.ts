import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSetupManifest } from "@synara/contracts";
import { AgentSetupEngine } from "./engine";
import { hashPackage, walkSkillManifests } from "./files";
import { defaultClientBindings } from "./adapters";
import { assertPersonalModelAllowed } from "./targeting";

const homes: string[] = [];
async function fixture() {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "synara-agent-setup-")));
  homes.push(home);
  const root = path.join(home, ".agents");
  const source = path.join(root, "catalog/skills/example");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    "---\nname: example\ndescription: An example workflow.\n---\nFollow the project policy.\n",
  );
  const manifest: AgentSetupManifest = {
    schemaVersion: 1,
    resources: [
      {
        id: "skill:example",
        name: "example",
        kind: "skill",
        source,
        ownership: "managed-shared",
        enabled: true,
        requirements: [],
        aliases: [],
        upstream: [],
        targetingExceptions: [],
      },
    ],
    clients: defaultClientBindings()
      .filter((client) => ["codex", "claude"].includes(client.id))
      .map((client) => ({ ...client, executable: "missing-agent-fixture" })),
    inventoryRoots: [
      { path: path.join(root, "skills"), owner: "shared" },
      { path: path.join(home, ".claude/skills"), owner: "claude" },
    ],
    targetingExceptions: [],
  };
  await fs.writeFile(path.join(root, "setup.json"), JSON.stringify(manifest));
  return {
    home,
    root,
    source,
    manifest,
    engine: new AgentSetupEngine(home),
    saveManifest: async () => fs.writeFile(path.join(root, "setup.json"), JSON.stringify(manifest)),
  };
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("portable package inventory", () => {
  it("hashes scripts and assets as well as manifests", async () => {
    const { root, source } = await fixture();
    const second = path.join(root, "catalog/skills/other");
    await fs.cp(source, second, { recursive: true });
    expect((await hashPackage(source)).hash).toBe((await hashPackage(second)).hash);
    await fs.mkdir(path.join(second, "scripts"));
    await fs.writeFile(path.join(second, "scripts/run.sh"), "exit 1");
    expect((await hashPackage(source)).hash).not.toBe((await hashPackage(second)).hash);
  });
  it("finds nested synced packages and bounds archives, broken links and cycles", async () => {
    const { root, source } = await fixture();
    const skills = path.join(root, "skills");
    await fs.mkdir(path.join(skills, "synced/account-id"), { recursive: true });
    await fs.symlink(source, path.join(skills, "synced/account-id/example"));
    await fs.symlink(source, path.join(skills, "alias"));
    await fs.mkdir(path.join(skills, ".archived"));
    await fs.writeFile(path.join(skills, ".archived/SKILL.md"), "archived");
    await fs.symlink(path.join(skills, ".archived"), path.join(skills, "retired-alias"));
    await fs.symlink(skills, path.join(skills, "cycle"));
    await fs.symlink(path.join(root, "missing"), path.join(skills, "broken"));
    expect(await walkSkillManifests(skills)).toHaveLength(1);
    expect(await walkSkillManifests(path.join(root, "missing"))).toEqual([]);
    expect(await walkSkillManifests(path.join(skills, ".archived"))).toEqual([]);
    expect(await walkSkillManifests(skills, { followSymlinks: false })).toEqual([]);
  });
  it("keeps divergent external resources distinct and read-only", async () => {
    const { home, source, engine } = await fixture();
    const external = path.join(home, ".claude/skills/example");
    await fs.mkdir(external, { recursive: true });
    await fs.cp(source, external, { recursive: true });
    await fs.writeFile(path.join(external, "extra.txt"), "different package");
    const inventory = await engine.inventory();
    expect(
      inventory.resources
        .find((resource) => resource.id === "skill:example")
        ?.copies.some((copy) => copy.relation === "divergent"),
    ).toBe(true);
    const resource = inventory.resources.find((item) => item.ownership === "external")!;
    expect(resource.id).not.toBe("skill:example");
    const read = await engine.readResource({ id: resource.id });
    expect(read.editable).toBe(false);
    await expect(
      engine.saveResource({
        id: read.id,
        file: read.file,
        expectedRevision: read.revision,
        content: "overwrite",
      }),
    ).rejects.toThrow("read-only");
  });
});

describe("reviewed reconciliation", () => {
  it("honors operator restrictions without changing the selected model or introducing a fallback", async () => {
    const { home, manifest, saveManifest } = await fixture();
    Object.assign(manifest, {
      targetingExceptions: [
        {
          selector: "*restricted-family*",
          effect: "deny",
          rationale: "Operator restriction",
          reviewDate: "2027-01-01",
        },
      ],
    });
    await saveManifest();
    await expect(assertPersonalModelAllowed(home, "vendor-restricted-family-1")).rejects.toThrow(
      "No model was substituted",
    );
    await expect(assertPersonalModelAllowed(home, "selected-other-model")).resolves.toBeUndefined();
  });
  it("rejects simultaneous reconciliation and recovers an interrupted apply before accepting another", async () => {
    const { root, engine } = await fixture();
    const plan = await engine.preview();
    await fs.writeFile(
      path.join(root, ".state/reconciliation.lock"),
      JSON.stringify({ pid: process.pid, token: "other-client" }),
    );
    await expect(engine.apply(plan.revision)).rejects.toThrow("already running");
    await fs.unlink(path.join(root, ".state/reconciliation.lock"));
    const result = await engine.apply(plan.revision);
    const file = path.join(root, ".state/backups", result.backupReferences[0]!, "journal.json");
    const journal = JSON.parse(await fs.readFile(file, "utf8"));
    journal.status = "applying";
    for (const entry of journal.entries) delete entry.afterRevision;
    await fs.writeFile(file, JSON.stringify(journal));
    const next = await engine.preview();
    await expect(engine.apply(next.revision)).rejects.toThrow("interrupted");
    expect((await engine.rollback(journal.id)).failures).toEqual([]);
    expect(await walkSkillManifests(path.join(root, "skills"))).toEqual([]);
  });
  it("adds package scripts with optimistic revisions and translates legacy disable names", async () => {
    const { engine, root, source } = await fixture();
    const read = await engine.readResource({ id: "skill:example", file: "scripts/new.sh" });
    await engine.saveResource({ ...read, expectedRevision: read.revision, content: "echo new\n" });
    expect(await fs.readFile(path.join(source, "scripts/new.sh"), "utf8")).toBe("echo new\n");
    expect(await walkSkillManifests(path.join(root, "skills"))).toEqual([]);
    await engine.translateLegacyDisabled([], ["example"]);
    expect(
      (await engine.inventory()).resources.find((item) => item.id === "skill:example")?.enabled,
    ).toBe(false);
    await engine.translateLegacyDisabled(["example"], []);
    expect(
      (await engine.inventory()).resources.find((item) => item.id === "skill:example")?.enabled,
    ).toBe(true);
  });
  it("upgrades previously managed source links into frozen package exports", async () => {
    const { root, source, engine } = await fixture();
    const initial = await engine.preview();
    await engine.apply(initial.revision);
    const target = path.join(root, "skills/example");
    await fs.rm(target, { recursive: true });
    await fs.symlink(source, target);
    const { snapshot } = await import("./files");
    const deploymentsFile = path.join(root, ".state/deployments.json");
    const deployments = JSON.parse(await fs.readFile(deploymentsFile, "utf8"));
    deployments.find((entry: { path: string }) => entry.path === target).revision = (
      await snapshot(target)
    ).revision;
    await fs.writeFile(deploymentsFile, JSON.stringify(deployments));
    const upgrade = await engine.preview();
    const result = await engine.apply(upgrade.revision);
    expect(result.failures).toEqual([]);
    expect((await fs.lstat(target)).isDirectory()).toBe(true);
    await engine.rollback(result.backupReferences[0]!);
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
  });
  it("keeps edited sources pending until package reconciliation, including script-only changes", async () => {
    const { root, source, engine } = await fixture();
    await fs.mkdir(path.join(source, "scripts"));
    await fs.writeFile(path.join(source, "scripts/run.sh"), "echo original\n");
    const initial = await engine.preview();
    await engine.apply(initial.revision);
    await fs.writeFile(path.join(source, "scripts/run.sh"), "echo updated\n");
    expect(await fs.readFile(path.join(root, "skills/example/scripts/run.sh"), "utf8")).toBe(
      "echo original\n",
    );
    const pending = await engine.preview();
    expect(pending.operations).toHaveLength(1);
    expect(pending.operations[0]?.kind).toBe("package");
    expect(pending.operations[0]?.after).toContain("echo updated");
    const applied = await engine.apply(pending.revision);
    expect(await fs.readFile(path.join(root, "skills/example/scripts/run.sh"), "utf8")).toBe(
      "echo updated\n",
    );
    await engine.rollback(applied.backupReferences[0]!);
    expect(await fs.readFile(path.join(root, "skills/example/scripts/run.sh"), "utf8")).toBe(
      "echo original\n",
    );
    expect(await fs.readFile(path.join(source, "scripts/run.sh"), "utf8")).toBe("echo updated\n");
  });
  it("preserves an external edit in a managed package", async () => {
    const { root, source, engine } = await fixture();
    const initial = await engine.preview();
    await engine.apply(initial.revision);
    await fs.writeFile(path.join(root, "skills/example/local.txt"), "Keep my edit");
    await fs.appendFile(path.join(source, "SKILL.md"), "New source\n");
    expect((await engine.preview()).conflicts.join(" ")).toContain("external edit");
    expect(await fs.readFile(path.join(root, "skills/example/local.txt"), "utf8")).toBe(
      "Keep my edit",
    );
  });
  it("exports the same source across clients, disables native discovery, and is idempotent", async () => {
    const { home, root, source, engine, manifest, saveManifest } = await fixture();
    const plan = await engine.preview();
    expect(plan.conflicts).toEqual([]);
    expect(plan.operations).toHaveLength(2);
    const result = await engine.apply(plan.revision);
    expect(result.failures).toEqual([]);
    expect((await fs.lstat(path.join(root, "skills/example"))).isDirectory()).toBe(true);
    expect((await hashPackage(path.join(root, "skills/example"))).hash).toBe(
      (await hashPackage(source)).hash,
    );
    expect(await fs.realpath(path.join(home, ".claude/skills/example"))).toBe(
      path.join(root, "skills/example"),
    );
    expect((await engine.preview()).operations).toEqual([]);
    Object.assign(manifest, {
      resources: manifest.resources.map((resource) => ({ ...resource, enabled: false })),
    });
    await saveManifest();
    const disabled = await engine.preview();
    expect(disabled.operations.every((operation) => operation.kind === "remove")).toBe(true);
    await engine.apply(disabled.revision);
    expect(await walkSkillManifests(path.join(root, "skills"))).toEqual([]);
    expect(
      (await engine.inventory()).resources.find((resource) => resource.id === "skill:example")
        ?.files,
    ).toContain("SKILL.md");
  });
  it("refuses a stale preview after a source edit and emits a fresh preview", async () => {
    const { source, root, engine } = await fixture();
    const plan = await engine.preview();
    await fs.appendFile(path.join(source, "SKILL.md"), "Concurrent change.\n");
    await expect(engine.apply(plan.revision)).rejects.toThrow("stale");
    expect(await walkSkillManifests(path.join(root, "skills"))).toEqual([]);
    expect(
      JSON.parse(await fs.readFile(path.join(root, ".state/preview.json"), "utf8")).revision,
    ).not.toBe(plan.revision);
  });
  it("preserves unowned targets and later edits, including during rollback", async () => {
    const { home, engine, root, manifest, saveManifest } = await fixture();
    const target = path.join(home, ".codex/AGENTS.md");
    const source = path.join(root, "AGENTS.md");
    await fs.writeFile(source, "Personal instructions.\n");
    Object.assign(manifest, {
      resources: [
        ...manifest.resources,
        {
          id: "personal",
          name: "personal",
          kind: "instructions",
          source,
          ownership: "managed-shared",
          enabled: true,
          requirements: [],
          aliases: [],
          upstream: [],
          targetingExceptions: [],
        },
      ],
    });
    await saveManifest();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "Native policy.\n");
    expect((await engine.preview()).conflicts.join(" ")).toContain("unowned");
    await fs.unlink(target);
    const plan = await engine.preview();
    const result = await engine.apply(plan.revision);
    await fs.appendFile(target, "Later user edit.\n");
    await expect(engine.rollback(result.backupReferences[0]!)).rejects.toThrow("later edit");
    expect(await fs.readFile(target, "utf8")).toContain("Later user edit");
    expect((await engine.preview()).conflicts.join(" ")).toContain("external edit");
  });
  it("rolls back exports with restricted backups", async () => {
    const { root, engine } = await fixture();
    const plan = await engine.preview();
    const result = await engine.apply(plan.revision);
    const backup = path.join(root, ".state/backups", result.backupReferences[0]!, "journal.json");
    expect((await fs.stat(backup)).mode & 0o077).toBe(0);
    await engine.rollback(result.backupReferences[0]!);
    expect(await walkSkillManifests(path.join(root, "skills"))).toEqual([]);
    expect((await engine.preview()).operations).toHaveLength(2);
  });
  it("restores a file replaced by a package, including its original permissions", async () => {
    const { root, engine } = await fixture();
    const target = path.join(root, "skills/example");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "");
    await fs.chmod(target, 0o666);
    const plan = await engine.preview();
    expect(plan.conflicts).toEqual([]);
    const result = await engine.apply(plan.revision);
    expect(result.failures).toEqual([]);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    await engine.rollback(result.backupReferences[0]!);
    expect(await fs.readFile(target, "utf8")).toBe("");
    if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o666);
  });
  it("restores the permissions of a retired package directory", async () => {
    const { root, engine, manifest, saveManifest } = await fixture();
    const target = path.join(root, "skills/example");
    const initial = await engine.preview();
    await engine.apply(initial.revision);
    await fs.chmod(target, 0o700);
    const { snapshot } = await import("./files");
    const deploymentsFile = path.join(root, ".state/deployments.json");
    const deployments = JSON.parse(await fs.readFile(deploymentsFile, "utf8"));
    deployments.find((entry: { path: string }) => entry.path === target).revision = (
      await snapshot(target)
    ).revision;
    await fs.writeFile(deploymentsFile, JSON.stringify(deployments));
    Object.assign(manifest, {
      resources: manifest.resources.map((resource) => ({ ...resource, enabled: false })),
    });
    await saveManifest();
    const disabled = await engine.preview();
    const result = await engine.apply(disabled.revision);
    await engine.rollback(result.backupReferences[0]!);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
  });
  it("requires source revisions for saves and rejects escaping package links", async () => {
    const { source, root, engine } = await fixture();
    const opened = await engine.readResource({ id: "skill:example" });
    await fs.appendFile(path.join(source, "SKILL.md"), "Outside editor.\n");
    await expect(
      engine.saveResource({
        id: opened.id,
        file: opened.file,
        expectedRevision: opened.revision,
        content: "replacement",
      }),
    ).rejects.toThrow("changed");
    await fs.writeFile(path.join(root, "outside.md"), "Private data");
    await fs.symlink(path.join(root, "outside.md"), path.join(source, "escape.md"));
    await expect(engine.readResource({ id: opened.id, file: "escape.md" })).rejects.toThrow(
      "escapes",
    );
  });
  it("reports missing clients as unverified and external disablement as limited", async () => {
    const { engine } = await fixture();
    const inventory = await engine.inventory();
    expect(
      inventory.clients.every(
        (client) => client.verification === "unverified" && !client.runtimePath,
      ),
    ).toBe(true);
    expect(
      inventory.clients[0]?.features.find((feature) => feature.feature === "disablement")
        ?.limitation,
    ).toContain("Client-owned");
  });
});
