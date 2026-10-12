import "../index.css";
import type { ContextMenuItem } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  external: vi.fn(),
  menu: vi.fn(
    async (_items: readonly ContextMenuItem[], _position?: { x: number; y: number }) =>
      null as string | null,
  ),
}));
vi.mock("~/lib/pdf/usePdfPageRender", () => ({
  usePdfPageRender: () => ({
    renderedSize: null,
    error: null,
    links: [
      { id: "web", left: 10, top: 10, width: 180, height: 20, url: "https://example.com/docs" },
      { id: "page", left: 10, top: 40, width: 180, height: 20, targetPageNumber: 2 },
    ],
  }),
}));
vi.mock("~/lib/linkChips", async (original) => ({
  ...(await original<typeof import("~/lib/linkChips")>()),
  openExternalLink: harness.external,
}));
vi.mock("~/nativeApi", async (original) => ({
  ...(await original<typeof import("~/nativeApi")>()),
  readNativeApi: () => ({ contextMenu: { show: harness.menu } }),
}));

import ChatMarkdown from "./ChatMarkdown";
import { InlineLinkChip } from "./InlineLinkChip";
import { LinkActionsProvider } from "./LinkActionsProvider";
import type { ChatLinkActions } from "~/lib/linkContextMenu";
import { PdfPageView } from "./pdf/PdfPageView";
import type { PDFDocumentProxy } from "~/lib/pdf/pdfEngine";

afterEach(() => {
  vi.clearAllMocks();
});

const URL = "https://example.com/docs";
const PR_URL = "https://github.com/acme/widgets/pull/41";

function preventNavigation(event: Event) {
  event.preventDefault();
}

function actions(patch: Partial<ChatLinkActions> = {}): ChatLinkActions {
  return { openInBrowserPanel: vi.fn(), openGitHubItem: vi.fn(), ...patch };
}

describe("link destination interactions", () => {
  it("routes PDF web links through the preference and keeps document page jumps internal", async () => {
    const target = actions();
    const jump = vi.fn();
    const screen = await render(
      <LinkActionsProvider actions={target}>
        <PdfPageView
          document={{} as PDFDocumentProxy}
          pageNumber={1}
          scale={1}
          intrinsicSize={{ width: 300, height: 200 }}
          scrollRoot={null}
          registerElement={vi.fn()}
          onJumpToPage={jump}
        />
      </LinkActionsProvider>,
    );
    await screen.getByRole("link", { name: URL }).click();
    expect(target.openInBrowserPanel).toHaveBeenCalledWith(URL);
    await screen.getByRole("button", { name: "Go to page 2" }).click();
    expect(jump).toHaveBeenCalledWith(2);
    expect(target.openInBrowserPanel).toHaveBeenCalledOnce();
  });
  it("opens authored markdown, user link chips, and composer link chips in the task browser", async () => {
    const target = actions();
    const client = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <LinkActionsProvider actions={target}>
          <ChatMarkdown text={`[Documentation](${URL})`} cwd="/workspace" />
          <InlineLinkChip url={URL} interactive />
          <InlineLinkChip url="https://example.com/composer" />
        </LinkActionsProvider>
      </QueryClientProvider>,
    );
    await screen.getByRole("link", { name: "Documentation" }).click();
    await screen.getByRole("button", { name: "example.com/docs" }).click();
    await screen.getByRole("link", { name: "example.com/composer" }).click();
    expect(target.openInBrowserPanel).toHaveBeenCalledTimes(3);
    expect(harness.external).not.toHaveBeenCalled();
    client.clear();
  });

  it("routes nested and portaled anchors once, and honors custom handlers and downloads", async () => {
    const target = actions();
    const clickHandled = vi.fn();
    const screen = await render(
      <LinkActionsProvider actions={target}>
        <a href={URL}>
          <span>Nested link</span>
        </a>
        <a href={URL} download>
          Download
        </a>
        <a
          href={URL}
          onClick={(event) => {
            event.preventDefault();
            clickHandled();
          }}
        >
          Custom action
        </a>
        {createPortal(<a href={URL}>Portaled link</a>, document.body)}
      </LinkActionsProvider>,
    );
    await screen.getByText("Nested link").click();
    document.querySelector<HTMLAnchorElement>(`body > a[href="${URL}"]`)!.click();
    expect(target.openInBrowserPanel).toHaveBeenCalledTimes(2);
    await screen.getByText("Custom action").click();
    expect(clickHandled).toHaveBeenCalledOnce();
    const download = screen.getByText("Download").element();
    document.addEventListener("click", preventNavigation);
    download.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.removeEventListener("click", preventNavigation);
    expect(target.openInBrowserPanel).toHaveBeenCalledTimes(2);
  });

  it("switches the destination immediately and preserves modifier overrides", async () => {
    const browser = actions();
    const screen = await render(
      <LinkActionsProvider actions={browser}>
        <InlineLinkChip url={URL} interactive />
      </LinkActionsProvider>,
    );
    const chip = screen.getByRole("button", { name: "example.com/docs" });
    chip
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(harness.external).toHaveBeenCalledWith(URL);
    expect(browser.openInBrowserPanel).not.toHaveBeenCalled();
    const external = actions({ webLinkOpenTarget: "external" });
    await screen.rerender(
      <LinkActionsProvider actions={external}>
        <InlineLinkChip url={URL} interactive />
      </LinkActionsProvider>,
    );
    await chip.click();
    expect(harness.external).toHaveBeenCalledTimes(2);
    expect(external.openInBrowserPanel).not.toHaveBeenCalled();
  });

  it("keeps the review destination and offers the external browser as a submenu override", async () => {
    const target = actions();
    const screen = await render(
      <LinkActionsProvider actions={target}>
        <InlineLinkChip url={PR_URL} interactive />
      </LinkActionsProvider>,
    );
    await screen.getByRole("button", { name: "acme/widgets#41" }).click();
    expect(target.openGitHubItem).toHaveBeenCalledWith(PR_URL);
    harness.menu.mockResolvedValueOnce("open-external");
    screen
      .getByRole("button", { name: "acme/widgets#41" })
      .element()
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await expect.poll(() => harness.external.mock.calls.length).toBe(1);
    expect(harness.menu.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Open link",
          children: expect.arrayContaining([
            expect.objectContaining({ id: "open-in-browser" }),
            expect.objectContaining({ id: "open-external" }),
          ]),
        }),
      ]),
    );
  });
});
