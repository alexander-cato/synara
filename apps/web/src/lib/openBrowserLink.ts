import type { ThreadId } from "@synara/contracts";

import { useBrowserStateStore } from "~/browserStateStore";
import { toastManager } from "~/components/ui/toast";
import { isElectron } from "~/env";
import { openExternalLink } from "~/lib/linkChips";
import { readNativeApi } from "~/nativeApi";

/** Reveal the existing task browser only after the desktop has accepted the URL. */
export function openLinkInBrowserPanel(
  url: string,
  threadId: ThreadId,
  showPanel: () => void,
): void {
  const api = readNativeApi();
  if (!isElectron || !api) {
    openExternalLink(url);
    return;
  }
  void api.browser
    .open({ threadId, initialUrl: url })
    .then((state) => {
      useBrowserStateStore.getState().upsertThreadState(state);
      showPanel();
    })
    .catch((error) => {
      toastManager.add({
        type: "error",
        title: "Could not open link",
        description:
          error instanceof Error ? error.message : "The in-app browser could not open this page.",
      });
    });
}
