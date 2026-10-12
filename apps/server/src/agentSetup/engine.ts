import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { Schema } from "effect";
import {
  AgentRoleDefinition,
  AgentSetupManifest,
  type AgentApplyResult,
  type AgentReconcileOperation,
  type AgentReconcilePlan,
  type AgentResourceCopy,
  type AgentResourceDescriptor,
  type AgentResourceReadResult,
  type AgentResourceRegistration,
  type AgentSetupInventory,
} from "@synara/contracts";
import { convertClaudeRole } from "./roles";
import { appendConfigurationReference } from "./configuration";
import { inspectClient, resourceAvailability } from "./adapters";
import { clientVerificationRevision, probeClient, type ClientVerification } from "./verification";
import {
  assertSafeTarget,
  atomicWrite,
  digest,
  expandHome,
  fileIdentity,
  hashPackage,
  packagePreview,
  isMissing,
  isWithin,
  snapshot,
  walkSkillManifests,
  type FileSnapshot,
} from "./files";

interface Deployment {
  path: string;
  resourceId: string;
  clientId: string;
  revision: string;
}
interface JournalEntry {
  operation: AgentReconcileOperation;
  before: FileSnapshot;
  afterRevision?: string;
  directoryBackup?: string;
  displacedPath?: string;
}
interface Journal {
  id: string;
  createdAt: string;
  status: string;
  entries: JournalEntry[];
  previousDeployments: Deployment[];
}
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const managed = (resource: AgentResourceRegistration): boolean =>
  resource.ownership === "managed-shared" || resource.ownership === "managed-integration";

/** One engine for RPC and the standalone command. No watcher applies changes. */
export class AgentSetupEngine {
  readonly root: string;
  readonly state: string;
  private watchers: FSWatcher[] = [];
  private generation = 0;
  constructor(
    readonly home: string,
    readonly extraRoots: readonly { path: string; owner: string }[] = [],
  ) {
    this.root = path.join(home, ".agents");
    this.state = path.join(this.root, ".state");
  }
  private resolve(value: string): string {
    return expandHome(value, this.home);
  }
  private async readManifest(): Promise<AgentSetupManifest> {
    try {
      const manifest = Schema.decodeUnknownSync(AgentSetupManifest)(
        JSON.parse(await fs.readFile(path.join(this.root, "setup.json"), "utf8")),
      );
      const ids = [
        ...manifest.resources.map((item) => item.id),
        ...manifest.clients.map((item) => `client:${item.id}`),
      ];
      if (new Set(ids).size !== ids.length)
        throw new Error("Resource and client IDs must be unique.");
      for (const resource of manifest.resources) {
        if (
          resource.kind === "skill" &&
          managed(resource) &&
          !/^[a-z0-9][a-z0-9-]{0,63}$/.test(resource.name)
        )
          throw new Error(`Invalid portable skill name: ${resource.name}`);
        if (managed(resource) && !isWithin(this.root, this.resolve(resource.source)))
          throw new Error(`Managed source must be inside ~/.agents: ${resource.id}`);
      }
      return manifest;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        schemaVersion: 1,
        resources: [],
        clients: [],
        inventoryRoots: [],
        targetingExceptions: [],
      };
    }
  }
  private async readDeployments(): Promise<Deployment[]> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.state, "deployments.json"), "utf8"),
      ) as Deployment[];
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  private async journals(): Promise<Journal[]> {
    const root = path.join(this.state, "backups");
    const names = await fs.readdir(root).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const results: Journal[] = [];
    for (const name of names.toSorted().toReversed()) {
      if (!/^[a-zA-Z0-9-]+$/.test(name)) continue;
      const file = path.join(root, name, "journal.json");
      try {
        results.push(JSON.parse(await fs.readFile(file, "utf8")) as Journal);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    return results;
  }
  private async fingerprint(
    source: string,
  ): Promise<{ hash: string; files: string[]; diagnostics: string[] }> {
    try {
      return { ...(await hashPackage(source)), diagnostics: [] };
    } catch (error) {
      return {
        hash: isMissing(error) ? "missing" : `unavailable:${digest(source)}`,
        files: [],
        diagnostics: [String(error)],
      };
    }
  }

  async inventory(): Promise<AgentSetupInventory> {
    const manifest = await this.readManifest();
    const manifestRevision = (await snapshot(path.join(this.root, "setup.json"))).revision;
    const resources: AgentResourceDescriptor[] = [];
    const copies: Array<AgentResourceCopy & { name: string; identity: string }> = [];
    const diagnostics: string[] = [];
    const roots = [...manifest.inventoryRoots, ...this.extraRoots];
    const seen = new Set<string>();
    for (const root of roots) {
      const rootPath = this.resolve(root.path);
      const paths = await walkSkillManifests(rootPath);
      for (const markdown of paths) {
        const directory = path.dirname(markdown);
        const identity = await fileIdentity(directory);
        if (seen.has(identity)) continue;
        seen.add(identity);
        const canonicalPath = await fs.realpath(directory);
        const { hash, diagnostics: errors } = await this.fingerprint(directory);
        diagnostics.push(...errors);
        const content = await fs.readFile(markdown, "utf8");
        const name =
          /^name:\s*["']?([^\r\n"']+)/m.exec(content)?.[1]?.trim() ?? path.basename(directory);
        copies.push({
          name,
          identity,
          path: directory,
          canonicalPath,
          packageHash: hash,
          ownership: "external",
          owner: root.owner,
          relation: "source",
        });
      }
    }
    const deployments = await this.readDeployments();
    for (const registration of manifest.resources) {
      const source = this.resolve(registration.source);
      const { hash, files, diagnostics: errors } = await this.fingerprint(source);
      const ownCopies: AgentResourceCopy[] = [];
      const canonicalPath = await fs.realpath(source).catch(() => source);
      ownCopies.push({
        path: source,
        canonicalPath,
        packageHash: hash,
        ownership: registration.ownership,
        owner: managed(registration) ? "personal" : (registration.upstream[0]?.owner ?? "external"),
        relation: registration.ownership === "archive" ? "archive" : "source",
      });
      const names = new Set(
        [registration.name, ...registration.aliases].map((name) => name.toLowerCase()),
      );
      for (const copy of copies) {
        const exported = deployments.some(
          (deployment) =>
            deployment.resourceId === registration.id && deployment.path === copy.path,
        );
        if (
          exported ||
          copy.canonicalPath === canonicalPath ||
          names.has(copy.name.toLowerCase())
        ) {
          if (copy.path !== source)
            ownCopies.push({
              ...copy,
              relation:
                exported || copy.canonicalPath === canonicalPath
                  ? "export"
                  : copy.packageHash === hash
                    ? "identical"
                    : "divergent",
              ownership:
                exported || copy.canonicalPath === canonicalPath ? "generated" : "external",
            });
        }
      }
      if (managed(registration)) {
        for (const archived of manifest.resources.filter(
          (item) =>
            item.ownership === "archive" &&
            item.kind === registration.kind &&
            item.name === registration.name,
        )) {
          const archivedSource = this.resolve(archived.source);
          const retired = await this.fingerprint(archivedSource);
          ownCopies.push({
            path: archivedSource,
            canonicalPath: await fs.realpath(archivedSource).catch(() => archivedSource),
            packageHash: retired.hash,
            ownership: "archive",
            owner: "migration backup",
            relation: "archive",
          });
        }
      }
      for (const deployment of deployments.filter((item) => item.resourceId === registration.id)) {
        if (ownCopies.some((copy) => copy.path === deployment.path)) continue;
        const deployed = await snapshot(deployment.path);
        ownCopies.push({
          path: deployment.path,
          canonicalPath: await fs.realpath(deployment.path).catch(() => deployment.path),
          packageHash: (await this.fingerprint(deployment.path)).hash,
          ownership: "generated",
          owner: deployment.clientId,
          relation: "export",
        });
        if (deployed.revision !== deployment.revision)
          errors.push(
            `External edit detected at managed output ${deployment.path}. Reconciliation will preserve it.`,
          );
      }
      for (const copy of ownCopies.filter(
        (copy) => copy.ownership === "generated" && registration.kind === "skill",
      )) {
        if ((await this.fingerprint(copy.path)).hash !== hash)
          errors.push(
            `Pending source/export difference at ${copy.path}; review reconciliation before updating native discovery.`,
          );
      }
      if (ownCopies.some((copy) => copy.relation === "divergent"))
        errors.push(
          "Same-name copies have different package contents. They retain separate ownership and identities.",
        );
      resources.push({
        ...registration,
        source,
        packageHash: hash,
        revision: hash,
        files,
        copies: ownCopies,
        diagnostics: errors,
      });
    }
    const registeredSources = new Set(
      resources.map((resource) => resource.copies[0]?.canonicalPath),
    );
    for (const copy of copies) {
      if (
        deployments.some((deployment) => deployment.path === copy.path) ||
        registeredSources.has(copy.canonicalPath) ||
        isWithin(path.join(this.root, "catalog"), copy.canonicalPath)
      )
        continue;
      const known = manifest.resources.find((resource) =>
        resource.upstream.some((upstream) => this.resolve(upstream.path) === copy.path),
      );
      if (known && copy.relation === "export") continue;
      const id = `external:${digest(copy.canonicalPath).slice(0, 24)}`;
      const { files, diagnostics: errors } = await this.fingerprint(copy.path);
      resources.push({
        id,
        name: copy.name,
        kind: "skill",
        source: copy.path,
        ownership: "external",
        enabled: true,
        requirements: [],
        aliases: [],
        upstream: [{ path: copy.path, owner: copy.owner }],
        targetingExceptions: [],
        packageHash: copy.packageHash,
        revision: copy.packageHash,
        files,
        copies: [copy],
        diagnostics: [
          ...errors,
          "Client-owned resource. Native enablement remains under its installer or client.",
        ],
      });
    }
    // Project locations are machine state; repository policy remains owned by its repository.
    const projectInventory: {
      resources: Array<{ path: string; disposition: string; limitation?: string }>;
    } = await fs
      .readFile(path.join(this.state, "project-migration/inventory.json"), "utf8")
      .then((content) => JSON.parse(content))
      .catch((error: unknown) => {
        if (isMissing(error)) return { resources: [] };
        throw error;
      });
    for (const project of projectInventory.resources) {
      if (!isWithin(this.home, project.path)) continue;
      const source = await fs.realpath(project.path).catch(() => project.path);
      if (resources.some((item) => item.source === source)) continue;
      const fingerprint = await this.fingerprint(source);
      resources.push({
        id: `project:${digest(source).slice(0, 24)}`,
        name: `${path.basename(path.dirname(source))} / ${path.basename(source)}`,
        kind: path.basename(source) === "AGENTS.md" ? "instructions" : "rule",
        source,
        ownership: "external",
        enabled: true,
        requirements: [],
        aliases: [],
        upstream: [{ path: source, owner: "repository" }],
        targetingExceptions: [],
        packageHash: fingerprint.hash,
        revision: fingerprint.hash,
        files: fingerprint.files,
        copies: [
          {
            path: project.path,
            canonicalPath: source,
            packageHash: fingerprint.hash,
            ownership: "external",
            owner: "repository",
            relation: "source",
          },
        ],
        diagnostics: [
          ...fingerprint.diagnostics,
          project.disposition,
          ...(project.limitation ? [project.limitation] : []),
          "Edit this source in its repository; personal reconciliation does not overwrite project policy.",
        ],
      });
    }
    // The registry is editable through the same revision-checked resource API.
    resources.push({
      id: "agent-setup-registry",
      name: "Agent setup registry",
      kind: "registry",
      source: path.join(this.root, "setup.json"),
      ownership: "managed-shared",
      enabled: true,
      requirements: [],
      aliases: [],
      upstream: [],
      targetingExceptions: [],
      packageHash: manifestRevision,
      revision: manifestRevision,
      copies: [],
      files: ["setup.json"],
      diagnostics: [],
    });
    const clients = await Promise.all(
      manifest.clients.map((client) =>
        inspectClient(
          client,
          resources.filter((resource) => resource.kind !== "registry"),
          this.home,
        ),
      ),
    );
    const verifications: ClientVerification[] = await fs
      .readFile(path.join(this.state, "client-verifications.json"), "utf8")
      .then((content) => JSON.parse(content))
      .catch((error: unknown) => {
        if (isMissing(error)) return [];
        throw error;
      });
    for (const [index, client] of clients.entries()) {
      const binding = manifest.clients.find((item) => item.id === client.id)!;
      const verification = verifications.find((item) => item.id === client.id);
      if (
        verification?.revision === (await clientVerificationRevision(binding, resources, this.home))
      ) {
        clients[index] = {
          ...client,
          verification: verification.verification,
          diagnostics: [
            ...client.diagnostics,
            `Checked ${verification.checkedAt}.`,
            ...verification.diagnostics,
          ],
        };
      } else if (verification)
        clients[index] = {
          ...client,
          diagnostics: [
            ...client.diagnostics,
            "Previous loading evidence is stale after a source, export, binding, or runtime change. Run the verification command again.",
          ],
        };
    }
    const outputRevisions = await Promise.all([
      ...deployments.map(async (deployment) => [
        deployment.path,
        (await snapshot(deployment.path)).revision,
      ]),
      ...manifest.clients.flatMap((client) =>
        [client.instructionConfig, client.skillConfig]
          .filter((binding) => binding !== undefined)
          .map(async (binding) => [
            binding.path,
            (await snapshot(this.resolve(binding.path))).revision,
          ]),
      ),
    ]);
    const history = (await this.journals()).map(({ id, createdAt, status }) => ({
      id,
      createdAt,
      status,
    }));
    if (history.some((item) => item.status === "applying" || item.status === "failed"))
      diagnostics.push(
        "An interrupted or failed apply has a recovery journal. Review and roll it back before another apply.",
      );
    if (manifestRevision === "missing")
      diagnostics.push(
        "No setup.json exists. Initialize the personal registry before applying exports.",
      );
    const revision = digest(json({ manifestRevision, resources, clients, outputRevisions }));
    return {
      schemaVersion: 1,
      revision,
      manifestRevision,
      sourceRoot: this.root,
      resources,
      clients,
      diagnostics,
      history,
    };
  }

  async readResource(input: {
    id: string;
    file?: string | undefined;
  }): Promise<AgentResourceReadResult> {
    const resource = (await this.inventory()).resources.find((item) => item.id === input.id);
    if (!resource) throw new Error(`Unknown resource: ${input.id}`);
    const sourceStat = await fs.stat(resource.source).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    const directory = sourceStat?.isDirectory() ?? resource.kind === "skill";
    const file =
      input.file ??
      (resource.kind === "skill"
        ? "SKILL.md"
        : (resource.files[0] ?? path.basename(resource.source)));
    const target = directory ? path.resolve(resource.source, file) : resource.source;
    if (directory && !isWithin(resource.source, target))
      throw new Error("Select an existing resource file.");
    const targetStat = await fs.stat(target).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!targetStat && managed(resource)) {
      if (!isWithin(this.root, target)) throw new Error("New source file escapes ~/.agents.");
      await assertSafeTarget(target, this.home);
      return { id: resource.id, file, revision: resource.revision, content: "", editable: true };
    }
    const realTarget = await fs.realpath(target);
    const realRoot = await fs.realpath(directory ? resource.source : path.dirname(resource.source));
    if (!isWithin(realRoot, realTarget)) throw new Error("Resource file escapes its package.");
    const stat = await fs.stat(realTarget);
    if (stat.size > 2 * 1024 * 1024) throw new Error("The text editor supports files up to 2 MB.");
    const content = await fs.readFile(realTarget, "utf8");
    if (content.includes("\0")) throw new Error("Binary assets cannot be edited as text.");
    return {
      id: resource.id,
      file,
      revision: resource.revision,
      content,
      editable: managed(resource),
    };
  }

  async verifyClients(clientId?: string): Promise<ClientVerification[]> {
    const manifest = await this.readManifest();
    const inventory = await this.inventory();
    if (clientId && !manifest.clients.some((client) => client.id === clientId))
      throw new Error(`Unknown client: ${clientId}`);
    const results: ClientVerification[] = [];
    for (const client of manifest.clients.filter(
      (client) => client.configured && (!clientId || client.id === clientId),
    )) {
      const result = await probeClient(
        client,
        inventory.clients.find((item) => item.id === client.id)!,
        inventory.resources,
        this.home,
      );
      if (result) results.push(result);
    }
    await this.withLock(async () => {
      const file = path.join(this.state, "client-verifications.json");
      const previous: ClientVerification[] = await fs
        .readFile(file, "utf8")
        .then((content) => JSON.parse(content))
        .catch((error: unknown) => {
          if (isMissing(error)) return [];
          throw error;
        });
      await atomicWrite(
        file,
        json([
          ...previous.filter((item) => !results.some((result) => result.id === item.id)),
          ...results,
        ]),
      );
    });
    return results;
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.state, { recursive: true, mode: 0o700 });
    await fs.chmod(this.state, 0o700);
    const lockPath = path.join(this.state, "reconciliation.lock");
    const token = randomUUID();
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid: number };
      try {
        process.kill(lock.pid, 0);
        throw new Error("Agent setup reconciliation is already running.", { cause: error });
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure;
        await fs.unlink(lockPath);
        return this.withLock(action);
      }
    }
    try {
      await handle.writeFile(json({ pid: process.pid, token }));
      await handle.close();
      return await action();
    } finally {
      const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token: string };
      if (lock.token === token) await fs.unlink(lockPath);
    }
  }

  async saveResource(input: {
    id: string;
    file: string;
    expectedRevision: string;
    content: string;
  }): Promise<AgentResourceReadResult> {
    return this.withLock(async () => {
      if (Buffer.byteLength(input.content) > 2 * 1024 * 1024 || input.content.includes("\0"))
        throw new Error("Source saves require text up to 2 MB.");
      const current = await this.readResource(input);
      if (!current.editable)
        throw new Error("External resources are read-only. Change their installer-owned source.");
      if (current.revision !== input.expectedRevision)
        throw new Error("Source changed since it was opened. Reload and review the new diff.");
      const resource = (await this.inventory()).resources.find((item) => item.id === input.id)!;
      if (resource.kind === "registry") {
        const proposed = Schema.decodeUnknownSync(AgentSetupManifest)(JSON.parse(input.content));
        for (const item of proposed.resources)
          if (managed(item) && !isWithin(this.root, this.resolve(item.source)))
            throw new Error(`Managed source outside ~/.agents: ${item.id}`);
      }
      if (resource.kind === "role")
        Schema.decodeUnknownSync(AgentRoleDefinition)(JSON.parse(input.content));
      const sourceStat = await fs.stat(resource.source).catch((error: unknown) => {
        if (isMissing(error)) return null;
        throw error;
      });
      const isDirectory = sourceStat?.isDirectory() ?? resource.kind === "skill";
      const target = isDirectory ? path.join(resource.source, input.file) : resource.source;
      const realTarget = await fs.realpath(target).catch((error: unknown) => {
        if (isMissing(error)) return target;
        throw error;
      });
      await assertSafeTarget(realTarget, this.home);
      if (!isWithin(await fs.realpath(this.root), realTarget))
        throw new Error("Editable source escapes ~/.agents.");
      const before = await snapshot(realTarget);
      const id = randomUUID();
      const journal: Journal = {
        id,
        createdAt: new Date().toISOString(),
        status: "applying",
        previousDeployments: await this.readDeployments(),
        entries: [
          {
            operation: {
              id: `${id}:save`,
              resourceId: input.id,
              clientId: "source",
              kind: "write",
              path: realTarget,
              expectedRevision: before.revision,
              before: before.content,
              after: input.content,
              restart: false,
            },
            before,
          },
        ],
      };
      await this.writeJournal(journal);
      await atomicWrite(realTarget, input.content, before.mode);
      journal.entries[0]!.afterRevision = (await snapshot(realTarget)).revision;
      journal.status = "applied";
      await this.writeJournal(journal);
      this.generation++;
      return this.readResource(input);
    });
  }

  private async desiredExports(
    manifest: AgentSetupManifest,
    inventory: AgentSetupInventory,
  ): Promise<
    Array<{
      resourceId: string;
      clientId: string;
      kind: "link" | "write" | "package";
      source?: string;
      sourceRevision?: string;
      path: string;
      after: string;
    }>
  > {
    const desired: Array<{
      resourceId: string;
      clientId: string;
      kind: "link" | "write" | "package";
      source?: string;
      sourceRevision?: string;
      path: string;
      after: string;
    }> = [];
    for (const resource of inventory.resources.filter((item) => managed(item) && item.enabled)) {
      if (resource.kind === "skill") {
        if (resource.targetingExceptions.length) continue; // Model-restricted packages cannot enter model-independent native discovery.
        const available = manifest.clients.filter(
          (client) => client.configured && !resourceAvailability(resource, client),
        );
        const shared = manifest.clients
          .filter((client) => client.configured && client.skillDelivery === "shared")
          .every((client) => !resourceAvailability(resource, client));
        const after = await packagePreview(resource.source);
        if (shared)
          desired.push({
            resourceId: resource.id,
            clientId: "shared",
            kind: "package",
            source: resource.source,
            sourceRevision: resource.packageHash,
            path: path.join(this.root, "skills", resource.name),
            after,
          });
        for (const client of available) {
          if (client.skillDelivery === "links" && client.skillTarget) {
            const target = path.join(this.resolve(client.skillTarget), resource.name);
            desired.push(
              shared
                ? {
                    resourceId: resource.id,
                    clientId: client.id,
                    kind: "link",
                    path: target,
                    after: path.join(this.root, "skills", resource.name),
                  }
                : {
                    resourceId: resource.id,
                    clientId: client.id,
                    kind: "package",
                    source: resource.source,
                    sourceRevision: resource.packageHash,
                    path: target,
                    after,
                  },
            );
          }
        }
      }
      if (resource.kind === "instructions") {
        for (const client of manifest.clients.filter(
          (item) => item.configured && item.instructionTarget,
        )) {
          desired.push({
            resourceId: resource.id,
            clientId: client.id,
            kind: "write",
            path: this.resolve(client.instructionTarget!),
            after:
              client.instructionFormat === "import"
                ? `@${resource.source}\n`
                : await fs.readFile(resource.source, "utf8"),
          });
        }
      }
      if (resource.kind === "role") {
        const role = Schema.decodeUnknownSync(AgentRoleDefinition)(
          JSON.parse(await fs.readFile(resource.source, "utf8")),
        );
        for (const client of manifest.clients.filter(
          (item) =>
            item.configured && item.id === "claude" && !resourceAvailability(resource, item),
        )) {
          const converted = convertClaudeRole(role);
          const selectedTools = converted.tools ?? [];
          desired.push({
            resourceId: resource.id,
            clientId: client.id,
            kind: "write",
            path: path.join(this.home, ".claude", "agents", `${role.id}.md`),
            after: `---\nname: ${JSON.stringify(role.id)}\ndescription: ${JSON.stringify(role.description)}\n${selectedTools.length ? `tools: ${selectedTools.join(", ")}\n` : ""}---\n\n${converted.prompt}\n`,
          });
        }
      }
    }
    return desired;
  }

  private async createPlan(): Promise<AgentReconcilePlan> {
    const inventory = await this.inventory();
    const manifest = await this.readManifest();
    const deployments = await this.readDeployments();
    const operations: AgentReconcileOperation[] = [];
    const conflicts: string[] = [];
    if (inventory.manifestRevision === "missing")
      conflicts.push("Initialize setup.json before applying a reconciliation plan.");
    for (const resource of inventory.resources.filter(
      (item) => managed(item) && item.enabled && item.kind !== "registry",
    ))
      if (resource.packageHash === "missing" || resource.packageHash.startsWith("unavailable:"))
        conflicts.push(`Source is unavailable: ${resource.id}. Repair it before applying exports.`);
    const sources = Object.fromEntries(
      inventory.resources.filter(managed).map((resource) => [resource.id, resource.revision]),
    );
    const desired = await this.desiredExports(manifest, inventory).catch((error: unknown) => {
      conflicts.push(String(error));
      return [];
    });
    const paths = new Set<string>();
    const nativeFields = new Set<string>();
    for (const client of manifest.clients.filter((item) => item.configured)) {
      for (const kind of ["instructions", "skills"] as const) {
        const binding = kind === "instructions" ? client.instructionConfig : client.skillConfig;
        if (!binding) continue;
        const target = this.resolve(binding.path);
        if (nativeFields.has(target)) {
          conflicts.push(`Multiple native configuration bindings target ${target}.`);
          continue;
        }
        nativeFields.add(target);
        await assertSafeTarget(target, this.home);
        const before = await snapshot(target);
        if (before.type !== "file" && before.type !== "missing") {
          conflicts.push(`Native configuration is not a regular file: ${target}`);
          continue;
        }
        try {
          const reference =
            kind === "instructions"
              ? path.join(this.root, "AGENTS.md")
              : path.join(this.root, "skills");
          const after = appendConfigurationReference(
            before.content,
            binding.format,
            binding.field,
            reference,
          );
          if (after !== before.content)
            operations.push({
              id: digest(`${target}:${after}`),
              resourceId: `configuration:${client.id}:${kind}`,
              clientId: client.id,
              kind: "write",
              path: target,
              expectedRevision: before.revision,
              before: before.content,
              after,
              restart: true,
            });
        } catch (error) {
          conflicts.push(String(error));
        }
      }
    }
    for (const output of desired.toSorted((left, right) => left.path.localeCompare(right.path))) {
      if (paths.has(output.path)) {
        conflicts.push(`Multiple bindings target ${output.path}.`);
        continue;
      }
      paths.add(output.path);
      try {
        await assertSafeTarget(output.path, this.home);
      } catch (error) {
        conflicts.push(String(error));
        continue;
      }
      const before = await snapshot(output.path);
      const same =
        (output.kind === "link" &&
          before.type === "link" &&
          path.resolve(path.dirname(output.path), before.content) === output.after) ||
        (output.kind === "write" && before.type === "file" && before.content === output.after) ||
        (output.kind === "package" &&
          before.type === "directory" &&
          before.content === output.sourceRevision);
      if (same) continue;
      const owned = deployments.find((deployment) => deployment.path === output.path);
      if (before.type !== "missing" && !(before.type === "file" && before.content === "")) {
        if (!owned || owned.revision !== before.revision) {
          conflicts.push(
            `Preserved ${output.path}: unowned content or an external edit. Move or adopt it explicitly before reconciliation.`,
          );
          continue;
        }
      }
      operations.push({
        ...output,
        id: digest(json(output)),
        expectedRevision: before.revision,
        before:
          output.kind === "package" && before.type === "directory"
            ? await packagePreview(output.path)
            : before.content,
        restart: output.clientId !== "shared" || output.kind === "package",
      });
    }
    for (const deployment of deployments.filter((item) => !paths.has(item.path))) {
      const before = await snapshot(deployment.path);
      if (before.type === "missing") continue;
      if (before.revision !== deployment.revision) {
        conflicts.push(`Preserved external edit at retired output ${deployment.path}.`);
        continue;
      }
      operations.push({
        id: digest(`remove:${deployment.path}`),
        resourceId: deployment.resourceId,
        clientId: deployment.clientId,
        kind: "remove",
        path: deployment.path,
        expectedRevision: before.revision,
        before: before.content,
        after: "",
        restart: deployment.clientId !== "shared",
      });
    }
    const value = {
      schemaVersion: 1 as const,
      inventoryRevision: inventory.revision,
      sourceRevisions: sources,
      operations,
      conflicts,
    };
    return { ...value, revision: digest(json(value)) };
  }

  async preview(): Promise<AgentReconcilePlan> {
    const plan = await this.createPlan();
    await fs.mkdir(this.state, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(this.state, "preview.json"), json(plan));
    return plan;
  }

  async translateLegacyDisabled(
    previous: readonly string[],
    next: readonly string[],
  ): Promise<void> {
    const manifest = await this.readManifest();
    if (!manifest.resources.length) return;
    const before = new Set(previous.map((name) => name.trim().toLowerCase()));
    const after = new Set(next.map((name) => name.trim().toLowerCase()));
    let changed = false;
    const resources = manifest.resources.map((resource) => {
      if (!managed(resource) || resource.kind !== "skill") return resource;
      const keys = [resource.id, resource.name, ...resource.aliases].map((name) =>
        name.toLowerCase(),
      );
      const wasDisabled = keys.some((key) => before.has(key));
      const isDisabled = keys.some((key) => after.has(key));
      if (wasDisabled === isDisabled) return resource;
      changed = true;
      return { ...resource, enabled: !isDisabled };
    });
    if (changed) {
      const opened = await this.readResource({ id: "agent-setup-registry" });
      await this.saveResource({
        id: opened.id,
        file: opened.file,
        expectedRevision: opened.revision,
        content: json({ ...manifest, resources }),
      });
    }
  }
  private async writeJournal(journal: Journal): Promise<void> {
    const root = path.join(this.state, "backups", journal.id);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await atomicWrite(path.join(root, "journal.json"), json(journal));
  }
  private async replaceTarget(stage: string, target: string, displacedPath: string): Promise<void> {
    const before = await fs.lstat(target).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    // A directory cannot be renamed over an existing file or symbolic link.
    // Journaled displacement also makes type changes recoverable after a crash.
    if (before && (before.isDirectory() || (await fs.lstat(stage)).isDirectory())) {
      await fs.rename(target, displacedPath);
      try {
        await fs.rename(stage, target);
      } catch (error) {
        await fs.rename(displacedPath, target);
        throw error;
      }
    } else await fs.rename(stage, target);
  }

  private async execute(
    operation: AgentReconcileOperation,
    before: FileSnapshot,
    displacedPath = path.join(this.state, "staging", randomUUID()),
    restoredMode?: number,
  ): Promise<void> {
    await assertSafeTarget(operation.path, this.home);
    if ((await snapshot(operation.path)).revision !== operation.expectedRevision)
      throw new Error(`Concurrent edit at ${operation.path}.`);
    await fs.mkdir(path.join(this.state, "staging"), { recursive: true, mode: 0o700 });
    if (operation.kind === "remove") {
      if (before.type === "directory") await fs.rename(operation.path, displacedPath);
      else await fs.unlink(operation.path);
      return;
    }
    await fs.mkdir(path.dirname(operation.path), { recursive: true });
    const stage = path.join(this.state, "staging", randomUUID());
    try {
      if (operation.kind === "write") {
        await atomicWrite(
          stage,
          operation.after,
          restoredMode ?? (before.type === "file" ? before.mode : 0o600),
        );
      } else if (operation.kind === "package") {
        if (!operation.source || !operation.sourceRevision)
          throw new Error("Package operation requires an exact source revision.");
        if ((await hashPackage(operation.source)).hash !== operation.sourceRevision)
          throw new Error(`Source changed during apply: ${operation.resourceId}`);
        await fs.cp(operation.source, stage, { recursive: true, dereference: true });
        await fs.chmod(stage, restoredMode ?? 0o755);
        if ((await hashPackage(stage)).hash !== operation.sourceRevision)
          throw new Error(`Source changed while copying ${operation.resourceId}.`);
      } else await fs.symlink(operation.after, stage);
      if ((await snapshot(operation.path)).revision !== operation.expectedRevision)
        throw new Error(`Concurrent edit at ${operation.path}.`);
      await this.replaceTarget(stage, operation.path, displacedPath);
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  }

  async apply(revision: string): Promise<AgentApplyResult> {
    return this.withLock(async () => {
      const approved = JSON.parse(
        await fs.readFile(path.join(this.state, "preview.json"), "utf8"),
      ) as AgentReconcilePlan;
      const current = await this.createPlan();
      if (approved.revision !== revision || current.revision !== revision) {
        await atomicWrite(path.join(this.state, "preview.json"), json(current));
        throw new Error(
          `Preview is stale. No changes were applied. Review the fresh preview ${current.revision}.`,
        );
      }
      if (current.conflicts.length)
        throw new Error(`Resolve reconciliation conflicts first: ${current.conflicts.join("; ")}`);
      if (
        (await this.journals()).some(
          (journal) => journal.status === "applying" || journal.status === "failed",
        )
      )
        throw new Error("Recover or roll back the interrupted apply first.");
      const result: {
        planRevision: string;
        completed: string[];
        failures: string[];
        backupReferences: string[];
        restartClients: string[];
      } = {
        planRevision: revision,
        completed: [],
        failures: [],
        backupReferences: [],
        restartClients: [],
      };
      if (current.operations.length === 0) return result;
      const journal: Journal = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "applying",
        entries: [],
        previousDeployments: await this.readDeployments(),
      };
      result.backupReferences.push(journal.id);
      await this.writeJournal(journal);
      for (const operation of current.operations) {
        try {
          const before = await snapshot(operation.path);
          const entry: JournalEntry = {
            operation,
            before,
            displacedPath: path.join(this.state, "staging", randomUUID()),
          };
          if (before.type === "directory") {
            entry.directoryBackup = path.join(
              this.state,
              "backups",
              journal.id,
              "packages",
              operation.id,
            );
            await fs.mkdir(path.dirname(entry.directoryBackup), { recursive: true, mode: 0o700 });
            await fs.cp(operation.path, entry.directoryBackup, {
              recursive: true,
              dereference: true,
            });
            if ((await snapshot(entry.directoryBackup)).revision !== before.revision)
              throw new Error(`Output changed while backing up ${operation.path}.`);
          }
          journal.entries.push(entry);
          await this.writeJournal(journal); // Durable undo information precedes every write.
          await this.execute(operation, before, entry.displacedPath);
          entry.afterRevision = (await snapshot(operation.path)).revision;
          await this.writeJournal(journal);
          result.completed.push(operation.id);
          if (operation.restart) {
            const clients =
              operation.clientId === "shared"
                ? (await this.readManifest()).clients
                    .filter((client) => client.configured && client.skillDelivery !== "manual")
                    .map((client) => client.id)
                : [operation.clientId];
            for (const client of clients)
              if (!result.restartClients.includes(client)) result.restartClients.push(client);
          }
        } catch (error) {
          result.failures.push(String(error));
          journal.status = "failed";
          break;
        }
      }
      if (!result.failures.length) {
        const desired = await this.desiredExports(
          await this.readManifest(),
          await this.inventory(),
        );
        const deployments = await Promise.all(
          desired.map(
            async (output): Promise<Deployment> => ({
              path: output.path,
              resourceId: output.resourceId,
              clientId: output.clientId,
              revision: (await snapshot(output.path)).revision,
            }),
          ),
        );
        await atomicWrite(path.join(this.state, "deployments.json"), json(deployments));
        journal.status = "applied";
      }
      await this.writeJournal(journal);
      if (journal.status === "applied")
        for (const entry of journal.entries)
          if (entry.displacedPath)
            await fs.rm(entry.displacedPath, { recursive: true, force: true });
      this.generation++;
      return result;
    });
  }

  async rollback(backupId: string): Promise<AgentApplyResult> {
    return this.withLock(async () => {
      if (!/^[a-zA-Z0-9-]+$/.test(backupId)) throw new Error("Invalid backup ID.");
      const journal = (await this.journals()).find((item) => item.id === backupId);
      if (!journal) throw new Error("Backup not found.");
      if (journal.status === "rolled-back")
        throw new Error("This backup has already been rolled back.");
      const result: {
        planRevision: string;
        completed: string[];
        failures: string[];
        backupReferences: string[];
        restartClients: string[];
      } = {
        planRevision: backupId,
        completed: [],
        failures: [],
        backupReferences: [backupId],
        restartClients: [],
      };
      // Refuse the entire rollback before writing if any later external edit would be lost.
      for (const entry of journal.entries) {
        const current = await snapshot(entry.operation.path);
        const expected =
          entry.afterRevision ??
          (entry.operation.kind === "remove"
            ? "missing"
            : entry.operation.kind === "package"
              ? digest(JSON.stringify(["directory", entry.operation.sourceRevision, 0o755]))
              : digest(
                  JSON.stringify([
                    entry.operation.kind === "link" ? "link" : "file",
                    entry.operation.after,
                    entry.before.type === "file" && entry.operation.kind === "write"
                      ? entry.before.mode
                      : entry.operation.kind === "link"
                        ? current.mode
                        : 0o600,
                  ]),
                ));
        const displaced = entry.displacedPath ? await snapshot(entry.displacedPath) : null;
        if (
          current.revision !== expected &&
          current.revision !== entry.before.revision &&
          !(current.type === "missing" && displaced?.revision === entry.before.revision)
        )
          throw new Error(
            `Rollback would lose a later edit at ${entry.operation.path}. Preserve and resolve it first.`,
          );
      }
      for (const entry of journal.entries.toReversed()) {
        if ((await snapshot(entry.operation.path)).revision === entry.before.revision) continue;
        const operation: AgentReconcileOperation = {
          ...entry.operation,
          expectedRevision: (await snapshot(entry.operation.path)).revision,
          kind:
            entry.before.type === "directory"
              ? "package"
              : entry.before.type === "missing"
                ? "remove"
                : entry.before.type === "link"
                  ? "link"
                  : "write",
          after: entry.before.content,
          ...(entry.before.type === "directory"
            ? { source: entry.directoryBackup!, sourceRevision: entry.before.content }
            : {}),
        };
        const displacedPath = path.join(this.state, "staging", randomUUID());
        await this.execute(
          operation,
          await snapshot(operation.path),
          displacedPath,
          entry.before.mode,
        );
        await fs.rm(displacedPath, { recursive: true, force: true });
        result.completed.push(operation.id);
        if (operation.restart && !result.restartClients.includes(operation.clientId))
          result.restartClients.push(operation.clientId);
      }
      const affected = new Set(
        journal.entries
          .filter((entry) => entry.operation.clientId !== "source")
          .map((entry) => entry.operation.path),
      );
      const retained = (await this.readDeployments()).filter(
        (deployment) => !affected.has(deployment.path),
      );
      await atomicWrite(
        path.join(this.state, "deployments.json"),
        json([
          ...retained,
          ...journal.previousDeployments.filter((deployment) => affected.has(deployment.path)),
        ]),
      );
      journal.status = "rolled-back";
      await this.writeJournal(journal);
      for (const entry of journal.entries)
        if (entry.displacedPath) await fs.rm(entry.displacedPath, { recursive: true, force: true });
      this.generation++;
      return result;
    });
  }

  async watchDrift(onInvalidate: () => void): Promise<() => void> {
    this.close();
    const manifest = await this.readManifest();
    const roots = [this.root, ...manifest.inventoryRoots.map((root) => this.resolve(root.path))];
    for (const root of new Set(roots)) {
      try {
        const watcher = watch(root, { recursive: true }, (_event, file) => {
          if (file && (file.startsWith(".state/") || file.startsWith(".git/"))) return;
          this.generation++;
          onInvalidate();
        });
        watcher.on("error", () => {
          this.generation++;
          onInvalidate();
        });
        this.watchers.push(watcher);
      } catch {
        /* Missing roots remain unverified. A future inventory still scans them. */
      }
    }
    return () => this.close();
  }
  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }
  get inventoryGeneration(): number {
    return this.generation;
  }
}
