import { describe, expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { appendConfigurationReference } from "./configuration";

describe("native configuration references", () => {
  it("retains JSONC comments, credentials, permission policy, models and existing paths", () => {
    const original =
      '{\n// Installer-owned block\n"model":"selected", "permissions":{"edit":"ask"}, "mcp":{"gateway":{"token":"fixture-only"}}, "instructions":["project.md"],\n}\n';
    const result = appendConfigurationReference(
      original,
      "jsonc",
      ["instructions"],
      "/fixture/.agents/AGENTS.md",
    );
    expect(result).toContain("// Installer-owned block");
    const before = parse(original),
      after = parse(result);
    expect(after).toEqual({
      ...before,
      instructions: ["project.md", "/fixture/.agents/AGENTS.md"],
    });
    expect(
      appendConfigurationReference(result, "jsonc", ["instructions"], "/fixture/.agents/AGENTS.md"),
    ).toBe(result);
  });
  it("edits a multiline TOML field without replacing native tables or the selected model", () => {
    const original =
      '# Native policy\nmodel = "selected"\n[skills]\npaths = [\n  "existing",\n]\n# Keep table comment\n[mcp.gateway]\ncommand = "native-gateway"\n';
    const result = appendConfigurationReference(
      original,
      "toml",
      ["skills", "paths"],
      "/fixture/.agents/skills",
    );
    expect(result).toContain("# Native policy");
    expect(result).toContain("# Keep table comment");
    expect(parseToml(result)).toEqual({
      ...parseToml(original),
      skills: { paths: ["existing", "/fixture/.agents/skills"] },
    });
    expect(
      appendConfigurationReference(result, "toml", ["skills", "paths"], "/fixture/.agents/skills"),
    ).toBe(result);
  });
  it("refuses unsupported conversions and malformed or incompatible native fields", () => {
    expect(() =>
      appendConfigurationReference('{"instructions":false}', "json", ["instructions"], "shared"),
    ).toThrow("string array");
    expect(() =>
      appendConfigurationReference("{broken", "jsonc", ["instructions"], "shared"),
    ).toThrow("Invalid native");
    expect(() =>
      appendConfigurationReference("", "toml", ["nested", "field", "paths"], "shared"),
    ).toThrow("Unsupported");
  });
});
