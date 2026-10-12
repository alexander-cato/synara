import { describe, expect, it } from "vitest";

import {
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsComputerRpcGroup,
  WsProjectAgentRpcGroup,
} from "./rpc";
import { COMPUTER_WS_METHODS } from "./computer";
import { ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WS_METHODS } from "./ws";
import { Schema } from "effect";
import {
  AgentResourceSaveInput,
  AgentReconcileApplyInput,
  AgentRoleDefinition,
} from "./agentSetup";

describe("WS RPC contracts", () => {
  it("registers revision-checked agent setup RPCs in the existing feature group", () => {
    for (const method of [
      WS_METHODS.agentSetupInventory,
      WS_METHODS.agentSetupReadResource,
      WS_METHODS.agentSetupSaveResource,
      WS_METHODS.agentSetupPreview,
      WS_METHODS.agentSetupApply,
      WS_METHODS.agentSetupRollback,
    ])
      expect(WsFeatureRpcGroup.requests.has(method)).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(AgentResourceSaveInput)({
        id: "source",
        file: "SKILL.md",
        content: "changed",
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(AgentReconcileApplyInput)({})).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentRoleDefinition)({
        schemaVersion: 1,
        id: "role",
        description: "role",
        instructions: "Work",
        requirements: [],
        model: "pinned-model",
        overrides: [],
      }),
    ).toThrow();
  });
  it("keeps bootstrap and feature RPCs in separate groups", () => {
    expect(WsBootstrapRpcGroup.requests.has("bootstrap.negotiate")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("bootstrap.negotiate")).toBe(false);
    expect(
      WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers),
    ).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery)).toBe(
      true,
    );
  });

  it("registers every computer method, including setup", () => {
    for (const method of Object.values(COMPUTER_WS_METHODS)) {
      expect(WsComputerRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("exports project-agent RPCs in a satellite group", () => {
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.linkProject")).toBe(true);
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.unlinkProject")).toBe(true);
    expect(WsProjectAgentRpcGroup.requests.has("projectAgent.getOverview")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("projectAgent.linkProject")).toBe(false);
    expect(WsFeatureRpcGroup.requests.has("projectAgent.getOverview")).toBe(false);
  });
});
