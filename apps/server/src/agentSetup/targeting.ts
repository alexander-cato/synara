import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Schema } from "effect";
import { AgentSetupManifest } from "@synara/contracts";
import { isMissing } from "./files";

/** Operator restrictions are portable policy; no provider or model family is hard-coded. */
export async function assertPersonalModelAllowed(home: string, model: string): Promise<void> {
  let manifest;
  try {
    manifest = Schema.decodeUnknownSync(AgentSetupManifest)(
      JSON.parse(await fs.readFile(path.join(home, ".agents/setup.json"), "utf8")),
    );
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const exception of manifest.targetingExceptions.filter((item) => item.effect === "deny")) {
    const expression = exception.selector
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    if (new RegExp(`^${expression}$`, "i").test(model))
      throw new Error(
        `Operator restriction denies model ${model}: ${exception.rationale} (review ${exception.reviewDate}). No model was substituted.`,
      );
  }
}
