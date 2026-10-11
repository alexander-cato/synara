import { describe, expect, it, vi } from "vitest";

import {
  parseGitHubItemUrl,
  resolveGitHubItemClickOpener,
  resolveLinkClickOpener,
  type ChatLinkActions,
} from "./linkContextMenu";

const PULL_REQUEST_URL = "https://github.com/acme/widgets/pull/41";
const ISSUE_URL = "https://github.com/acme/widgets/issues/42#issuecomment-1";

describe("parseGitHubItemUrl", () => {
  it("reads pull requests and issues", () => {
    expect(parseGitHubItemUrl(PULL_REQUEST_URL)).toEqual({
      kind: "pullRequest",
      repository: "acme/widgets",
      number: 41,
    });
    expect(parseGitHubItemUrl(ISSUE_URL)).toEqual({
      kind: "issue",
      repository: "acme/widgets",
      number: 42,
    });
  });

  it("ignores other URLs", () => {
    expect(parseGitHubItemUrl("https://github.com/acme/widgets")).toBeNull();
    expect(parseGitHubItemUrl("https://example.com/acme/widgets/pull/41")).toBeNull();
  });
});

describe("resolveLinkClickOpener", () => {
  const actions = (patch: Partial<ChatLinkActions> = {}): ChatLinkActions => ({
    openInBrowserPanel: vi.fn(),
    openGitHubItem: vi.fn(),
    ...patch,
  });

  it.each(["https://example.com/docs", "http://localhost:3000", "http://[::1]:5173/"])(
    "opens ordinary web links in the task browser by default: %s",
    (url) => {
      const target = actions();
      expect(resolveLinkClickOpener(url, target)).toBe(target.openInBrowserPanel);
    },
  );

  it("uses the external preference and falls back on unavailable surfaces", () => {
    expect(
      resolveLinkClickOpener("https://example.com", actions({ webLinkOpenTarget: "external" })),
    ).toBeUndefined();
    expect(
      resolveLinkClickOpener("https://example.com", actions({ browserAvailable: false })),
    ).toBeUndefined();
    expect(resolveLinkClickOpener("https://example.com", null)).toBeUndefined();
  });

  it.each([
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ])("leaves modified clicks external: %o", (event) => {
    expect(resolveLinkClickOpener("https://example.com", actions(), event)).toBeUndefined();
    expect(resolveLinkClickOpener(PULL_REQUEST_URL, actions(), event)).toBeUndefined();
  });

  it.each([
    "mailto:me@example.com",
    "javascript:alert(1)",
    "file:///tmp/readme.md",
    "thread://a",
    "/settings",
    "#heading",
    "https://",
    "https:////",
  ])("does not send non-web or malformed links to the task browser: %s", (url) => {
    expect(resolveLinkClickOpener(url, actions())).toBeUndefined();
  });

  it("keeps the GitHub review preference independent of the ordinary link preference", () => {
    const review = actions({ webLinkOpenTarget: "external" });
    expect(resolveLinkClickOpener(PULL_REQUEST_URL, review)).toBe(review.openGitHubItem);
    const external = actions({ githubLinkOpenTarget: "external" });
    expect(resolveLinkClickOpener(ISSUE_URL, external)).toBeUndefined();
    const browser = actions({ githubLinkOpenTarget: "browser", webLinkOpenTarget: "external" });
    expect(resolveLinkClickOpener(ISSUE_URL, browser)).toBe(browser.openInBrowserPanel);
  });

  it("falls back from unavailable built-in review to the browser only when available", () => {
    const shell = actions({ openGitHubItem: undefined });
    expect(resolveLinkClickOpener(PULL_REQUEST_URL, shell)).toBe(shell.openInBrowserPanel);
    expect(
      resolveLinkClickOpener(
        PULL_REQUEST_URL,
        actions({ openGitHubItem: undefined, browserAvailable: false }),
      ),
    ).toBeUndefined();
  });
});

describe("resolveGitHubItemClickOpener", () => {
  const actions = (githubLinkOpenTarget?: ChatLinkActions["githubLinkOpenTarget"]) =>
    ({
      openInBrowserPanel: vi.fn(),
      openGitHubItem: vi.fn(),
      githubLinkOpenTarget,
    }) satisfies ChatLinkActions;

  it("opens in the app by default", () => {
    const linkActions = actions();
    expect(resolveGitHubItemClickOpener(ISSUE_URL, linkActions)).toBe(linkActions.openGitHubItem);
  });

  it("follows the browser and external settings", () => {
    const browser = actions("browser");
    expect(resolveGitHubItemClickOpener(PULL_REQUEST_URL, browser)).toBe(
      browser.openInBrowserPanel,
    );
    expect(resolveGitHubItemClickOpener(PULL_REQUEST_URL, actions("external"))).toBeUndefined();
  });

  it("leaves other links and surfaces without actions external", () => {
    expect(resolveGitHubItemClickOpener("https://example.com", actions("app"))).toBeUndefined();
    expect(resolveGitHubItemClickOpener(PULL_REQUEST_URL, null)).toBeUndefined();
  });
});
