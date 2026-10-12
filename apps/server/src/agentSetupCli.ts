import * as os from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { AgentSetupEngine } from "./agentSetup/engine";

/** Standalone management uses exactly the same engine as the settings RPC. */
export async function runAgentSetupCommand(args: readonly string[]): Promise<unknown> {
  const [command = "inventory", ...flags] = args;
  const validFlags = new Set([
    "--home-dir",
    "--client",
    "--revision",
    "--backup-id",
    "--id",
    "--file",
    "--expected-revision",
    "--content-file",
  ]);
  for (let index = 0; index < flags.length; index += 2) {
    if (!validFlags.has(flags[index]!) || !flags[index + 1] || flags[index + 1]!.startsWith("--"))
      throw new Error(`Invalid or incomplete option: ${flags[index]}`);
  }
  const option = (name: string): string | undefined => {
    const index = flags.indexOf(name);
    return index < 0 ? undefined : flags[index + 1];
  };
  const required = (name: string): string => {
    const value = option(name);
    if (!value || value.startsWith("--")) throw new Error(`Required option: ${name}`);
    return value;
  };
  const engine = new AgentSetupEngine(path.resolve(option("--home-dir") ?? os.homedir()));
  switch (command) {
    case "inventory":
      return engine.inventory();
    case "preview":
      return engine.preview();
    case "verify":
      return engine.verifyClients(option("--client"));
    case "apply":
      return engine.apply(required("--revision"));
    case "rollback":
      return engine.rollback(required("--backup-id"));
    case "read":
      return engine.readResource({
        id: required("--id"),
        ...(option("--file") ? { file: option("--file")! } : {}),
      });
    case "save":
      return engine.saveResource({
        id: required("--id"),
        file: required("--file"),
        expectedRevision: required("--expected-revision"),
        content: await fs.readFile(required("--content-file"), "utf8"),
      });
    default:
      throw new Error(
        "Usage: synara-agent-setup inventory|verify [--client ID]|preview|apply --revision HASH|rollback --backup-id ID|read --id ID|save --id ID --file FILE --expected-revision HASH --content-file PATH [--home-dir PATH]",
      );
  }
}

const executedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (executedPath === (await fs.realpath(fileURLToPath(import.meta.url)))) {
  runAgentSetupCommand(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}
