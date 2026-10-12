import { describe, expect, it } from "vitest";
import type { AgentRoleDefinition } from "@synara/contracts";
import { convertClaudeRole } from "./roles";

const role: AgentRoleDefinition = {
  schemaVersion: 1,
  id: "reviewer",
  description: "Review changes",
  instructions: "Review correctness and tests.",
  model: "inherit",
  requirements: [{ capability: "filesystem-read", rationale: "Inspect the diff" }],
  overrides: [],
};
describe("portable role conversion", () => {
  it("inherits the active model while translating semantic tools", () => {
    const converted = convertClaudeRole(role);
    expect(converted).not.toHaveProperty("model");
    expect(converted.tools).toEqual(["Read", "Grep", "Glob"]);
  });
  it("refuses an unverified explicit model rather than substituting one", () => {
    expect(() =>
      convertClaudeRole({
        ...role,
        overrides: [
          {
            client: "claude",
            model: "unavailable",
            rationale: "Explicit request",
            reviewDate: "2027-01-01",
          },
        ],
      }),
    ).toThrow("No model was substituted");
  });
  it("reports a capability conversion that the client cannot provide", () => {
    expect(() =>
      convertClaudeRole({
        ...role,
        requirements: [{ capability: "native-browser", rationale: "Use the browser" }],
      }),
    ).toThrow("Unsupported Claude role requirement");
  });
});
