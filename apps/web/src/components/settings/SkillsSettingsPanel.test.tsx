import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentResourceDescriptor, AgentSetupInventory } from "@synara/contracts";
import { SkillsSettingsPanel } from "./SkillsSettingsPanel";

vi.mock("@tanstack/react-router", () => ({ useBlocker: vi.fn() }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/components/codeEditor/CodeEditorPane", () => ({ CodeEditorPane: () => null }));
vi.mock("~/components/codeEditor/CodeDiffEditorPane", () => ({ CodeDiffEditorPane: () => null }));

function resource(
  id: string,
  ownership: AgentResourceDescriptor["ownership"],
): AgentResourceDescriptor {
  return {
    id,
    name: "example",
    kind: "skill",
    source: `/fixture/${id}`,
    ownership,
    enabled: ownership !== "archive",
    requirements: [{ capability: "filesystem", rationale: "Read files" }],
    aliases: [],
    upstream: [],
    targetingExceptions: [],
    packageHash: id,
    revision: id,
    files: ["SKILL.md"],
    copies: [
      {
        path: `/fixture/${id}/copy`,
        canonicalPath: `/fixture/${id}`,
        packageHash: "different-package",
        ownership: "external",
        owner: "installer",
        relation: "divergent",
      },
    ],
    diagnostics: ["Package scripts differ."],
  };
}
function render(resources: AgentResourceDescriptor[], diagnostics: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const inventory: AgentSetupInventory = {
    schemaVersion: 1,
    revision: "revision",
    manifestRevision: "manifest",
    sourceRoot: "/fixture/.agents",
    resources,
    clients: [],
    diagnostics,
    history: [],
  };
  client.setQueryData(["agent-setup", "inventory"], inventory);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SkillsSettingsPanel />
    </QueryClientProvider>,
  );
}
describe("Agent setup settings", () => {
  it("shows canonical sources and same-name external variants separately with ownership and content differences", () => {
    const markup = render([resource("shared", "managed-shared"), resource("external", "external")]);
    expect(markup).toContain("Agent setup");
    expect(markup).toContain("/fixture/shared");
    expect(markup).toContain("/fixture/external");
    expect(markup).toContain("Edit source");
    expect(markup).toContain("Read source");
    expect(markup).toContain("Package scripts differ.");
    expect(markup).toContain("divergent");
    expect(markup).toContain("2 of 2 resources");
    expect(markup).toContain('aria-label="Search agent resources"');
    expect(markup).toContain('aria-label="Export example"');
    expect(markup).toContain('aria-label="Show in Synara example"');
  });
  it("keeps archives read-only and exposes recovery diagnostics and management views", () => {
    const markup = render(
      [resource("retired", "archive")],
      ["An interrupted apply has a recovery journal."],
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain("An interrupted apply has a recovery journal.");
    for (const view of ["Instructions", "Roles", "Integrations", "Clients", "Pending", "History"])
      expect(markup).toContain(view);
    expect(markup).toContain("Preview changes");
  });
});
