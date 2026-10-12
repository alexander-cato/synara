import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnProcess, execProcessFile } from "@synara/shared/processRuntime";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentClientBinding,
  AgentClientStatus,
  AgentResourceDescriptor,
} from "@synara/contracts";
import { digest, expandHome, snapshot } from "./files";
import { detectExecutable } from "./adapters";

export interface ClientVerification {
  id: string;
  checkedAt: string;
  revision: string;
  verification: "limited";
  diagnostics: string[];
}

export async function clientVerificationRevision(
  client: AgentClientBinding,
  resources: readonly AgentResourceDescriptor[],
  home: string,
): Promise<string> {
  const paths = [
    ...client.skillRoots,
    client.instructionTarget,
    client.instructionConfig?.path,
    client.skillConfig?.path,
  ].filter((value): value is string => Boolean(value));
  const locations = await Promise.all(
    paths.map(async (location) => {
      const target = expandHome(location, home);
      const stat = await fs.stat(target).catch(() => null);
      return [target, stat?.isDirectory() ? stat.mtimeMs : (await snapshot(target)).revision];
    }),
  );
  const runtime = await detectExecutable(client.executable, home);
  const runtimeStat = runtime ? await fs.stat(runtime).catch(() => null) : null;
  return digest(
    JSON.stringify({
      client,
      runtime: [runtime, runtimeStat?.mtimeMs, runtimeStat?.size],
      sources: resources
        .filter((item) => item.ownership.startsWith("managed"))
        .map((item) => [
          item.id,
          item.packageHash,
          item.enabled,
          item.copies
            .filter((copy) => copy.ownership === "generated")
            .map((copy) => [copy.path, copy.packageHash]),
        ]),
      locations,
    }),
  );
}

const execute = (
  executable: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) =>
  new Promise<{ stdout: string }>((resolve, reject) =>
    execProcessFile(executable, args, { ...options, encoding: "utf8" }, (error, stdout) =>
      error ? reject(error) : resolve({ stdout }),
    ),
  );
async function codexSkills(executable: string, cwd: string, configRoot: string): Promise<string[]> {
  const child = spawnProcess(executable, ["app-server", "--stdio"], {
    cwd,
    env: { ...process.env, CODEX_HOME: configRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 0;
  let buffer = "";
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    if (buffer.length > 4 * 1024 * 1024) {
      child.kill();
      return;
    }
    for (let boundary; (boundary = buffer.indexOf("\n")) >= 0; ) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      try {
        const response = JSON.parse(line);
        const waiter = pending.get(response.id);
        if (!waiter) continue;
        pending.delete(response.id);
        if (response.error) waiter.reject(new Error("Codex discovery request was rejected."));
        else waiter.resolve(response.result);
      } catch {
        /* Ignore non-protocol startup diagnostics. */
      }
    }
  });
  const closed = () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("Codex discovery process closed."));
    pending.clear();
  };
  child.on("error", closed);
  child.on("exit", closed);
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    await request("initialize", {
      clientInfo: { name: "synara_setup_probe", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const result = await request("skills/list", { cwds: [cwd], forceReload: true });
    const entries = result.data ?? result.skills ?? [];
    return entries
      .flatMap((entry: any) => entry.skills ?? [entry])
      .map((entry: any) => entry.name)
      .filter((name: unknown): name is string => typeof name === "string");
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

async function claudeSkills(
  cwd: string,
  configRoot: string,
  executable?: string,
): Promise<{ skills: string[]; roles: string[] }> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prompt = (async function* () {
    await hold;
  })();
  const session = query({
    prompt,
    options: {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: configRoot,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      settingSources: ["user", "project", "local"],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    },
  });
  const timer = setTimeout(() => {
    release();
    session.close();
  }, 20_000);
  try {
    const [skills, roles] = await Promise.all([
      session.supportedCommands(),
      session.supportedAgents(),
    ]);
    return { skills: skills.map((item) => item.name), roles: roles.map((item) => item.name) };
  } finally {
    clearTimeout(timer);
    release();
    session.close();
  }
}

/** Metadata-only probes never submit a model prompt or install a runtime. */
export async function probeClient(
  client: AgentClientBinding,
  status: AgentClientStatus,
  resources: readonly AgentResourceDescriptor[],
  home: string,
): Promise<ClientVerification | null> {
  if (!status.runtimePath && client.id !== "claude-sdk") return null;
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "synara-client-probe-"));
  const diagnostics: string[] = [];
  const cwd = path.join(fixture, "project");
  const config = path.join(fixture, "config");
  await fs.mkdir(cwd);
  await fs.mkdir(config);
  try {
    if (status.runtimePath) {
      try {
        const { stdout } = await execute(status.runtimePath, ["--version"], {
          cwd,
          timeout: 10_000,
          maxBuffer: 100_000,
        });
        diagnostics.push(`Runtime version probe: ${stdout.trim().split("\n")[0]?.slice(0, 160)}.`);
      } catch {
        diagnostics.push("Runtime version probe was not supported or did not finish.");
      }
    }
    let skills: string[] | undefined;
    if (client.id === "codex") skills = await codexSkills(status.runtimePath!, cwd, config);
    if (["claude", "claude-sdk"].includes(client.id)) {
      await fs.cp(path.join(home, ".claude/skills"), path.join(config, "skills"), {
        recursive: true,
        dereference: true,
        filter: (source) =>
          !source.split(path.sep).some((part) => ["synced", ".archived", "archive"].includes(part)),
      });
      await fs
        .cp(path.join(home, ".claude/agents"), path.join(config, "agents"), { recursive: true })
        .catch(() => undefined);
      await fs
        .copyFile(path.join(home, ".claude/CLAUDE.md"), path.join(config, "CLAUDE.md"))
        .catch(() => undefined);
      const result = await claudeSkills(
        cwd,
        config,
        client.id === "claude" ? status.runtimePath : undefined,
      );
      skills = result.skills;
      diagnostics.push(
        `Isolated ${client.id === "claude" ? "installed CLI" : "bundled SDK"} discovery returned ${result.roles.length} roles; no model prompt was submitted.`,
      );
    }
    if (client.id === "opencode") {
      const { stdout } = await execute(status.runtimePath!, ["--pure", "debug", "skill"], {
        cwd,
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const entries = JSON.parse(stdout);
      skills = (Array.isArray(entries) ? entries : Object.values(entries))
        .map((item: any) => item.name)
        .filter(Boolean);
    }
    if (skills) {
      const expected = resources.filter(
        (resource) =>
          resource.kind === "skill" &&
          resource.ownership.startsWith("managed") &&
          resource.enabled &&
          resource.requirements.every((item) => client.capabilities.includes(item.capability)) &&
          !resource.targetingExceptions.length,
      );
      const missing = expected.filter((resource) => !skills.includes(resource.name));
      diagnostics.push(
        `Native skill discovery observed ${expected.length - missing.length}/${expected.length} eligible managed packages (${skills.length} total commands/skills).${missing.length ? ` Missing: ${missing.map((item) => item.name).join(", ")}.` : ""}`,
      );
    } else
      diagnostics.push(
        "This adapter has no safe metadata-only instruction/skill loading probe; native loading remains unverified.",
      );
    if (client.instructionTarget) {
      const source = await fs.readFile(path.join(home, ".agents/AGENTS.md"), "utf8");
      const target = await fs.readFile(expandHome(client.instructionTarget, home), "utf8");
      diagnostics.push(
        source === target
          ? "Generated personal instructions match the canonical source. Native instruction injection remains unverified."
          : "Personal instruction output differs; review reconciliation.",
      );
    }
  } catch {
    diagnostics.push(
      "The metadata-only loading probe failed or timed out. Native loading remains unverified; no model request was made.",
    );
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
  return {
    id: client.id,
    checkedAt: new Date().toISOString(),
    revision: await clientVerificationRevision(client, resources, home),
    verification: "limited",
    diagnostics,
  };
}
