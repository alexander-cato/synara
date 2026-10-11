import { ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  desktop: true,
  open: vi.fn(),
  upsert: vi.fn(),
  external: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("~/env", () => ({
  get isElectron() {
    return harness.desktop;
  },
}));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({ browser: { open: harness.open } }) }));
vi.mock("~/browserStateStore", () => ({
  useBrowserStateStore: { getState: () => ({ upsertThreadState: harness.upsert }) },
}));
vi.mock("~/lib/linkChips", () => ({ openExternalLink: harness.external }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toast } }));

import { openLinkInBrowserPanel } from "./openBrowserLink";

afterEach(() => {
  vi.clearAllMocks();
  harness.desktop = true;
});

describe("openLinkInBrowserPanel", () => {
  const threadId = ThreadId.makeUnsafe("link-task");
  const url = "https://example.com/docs";

  it("waits for the browser and seeds its state before revealing the panel", async () => {
    const state = { threadId, version: 1 };
    let resolve!: (state: unknown) => void;
    harness.open.mockReturnValue(
      new Promise((accept) => {
        resolve = accept;
      }),
    );
    const showPanel = vi.fn();
    openLinkInBrowserPanel(url, threadId, showPanel);
    expect(harness.open).toHaveBeenCalledWith({ threadId, initialUrl: url });
    expect(showPanel).not.toHaveBeenCalled();
    resolve(state);
    await vi.waitFor(() => expect(showPanel).toHaveBeenCalledOnce());
    expect(harness.upsert).toHaveBeenCalledWith(state);
    expect(harness.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      showPanel.mock.invocationCallOrder[0]!,
    );
  });

  it("reports failure without opening an empty panel or a second browser", async () => {
    harness.open.mockRejectedValue(new Error("Browser unavailable"));
    const showPanel = vi.fn();
    openLinkInBrowserPanel(url, threadId, showPanel);
    await vi.waitFor(() =>
      expect(harness.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not open link",
          description: "Browser unavailable",
        }),
      ),
    );
    expect(showPanel).not.toHaveBeenCalled();
    expect(harness.upsert).not.toHaveBeenCalled();
    expect(harness.external).not.toHaveBeenCalled();
  });

  it("uses the external browser in the web client", () => {
    harness.desktop = false;
    const showPanel = vi.fn();
    openLinkInBrowserPanel(url, threadId, showPanel);
    expect(harness.external).toHaveBeenCalledWith(url);
    expect(harness.open).not.toHaveBeenCalled();
    expect(showPanel).not.toHaveBeenCalled();
  });
});
