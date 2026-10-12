import { type ReactNode } from "react";

import { useAppSettings } from "~/appSettings";
import { isElectron } from "~/env";
import { useFocusedChatContext } from "~/focusedChatContext";
import { useNavigate } from "@tanstack/react-router";
import { stripDiffSearchParams } from "~/diffRouteSearch";
import {
  ChatLinkActionsContext,
  resolveLinkClickOpener,
  showLinkContextMenu,
  type ChatLinkActions,
} from "~/lib/linkContextMenu";
import { openExternalLink } from "~/lib/linkChips";
import { openLinkInBrowserPanel } from "~/lib/openBrowserLink";
import { useSplitViewStore } from "~/splitViewStore";

/** Also covers ordinary anchors (including portaled menus) without overriding their handlers. */
export function LinkActionsProvider({
  actions,
  children,
}: {
  actions: ChatLinkActions;
  children: ReactNode;
}) {
  return (
    <ChatLinkActionsContext.Provider value={actions}>
      <div
        className="contents"
        onClick={(event) => {
          if (event.defaultPrevented || !(event.target instanceof Element)) return;
          const anchor = event.target.closest("a[href]");
          if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
          const href = anchor.getAttribute("href") ?? "";
          const opener = resolveLinkClickOpener(href, actions, event);
          if (!opener) return;
          event.preventDefault();
          event.stopPropagation();
          opener(href);
        }}
        onContextMenu={(event) => {
          if (event.defaultPrevented || !(event.target instanceof Element)) return;
          const anchor = event.target.closest("a[href]");
          if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
          const url = anchor.getAttribute("href") ?? "";
          if (!/^https?:\/\//i.test(url)) return;
          event.preventDefault();
          event.stopPropagation();
          void showLinkContextMenu({
            url,
            position: { x: event.clientX, y: event.clientY },
            actions,
          });
        }}
      >
        {children}
      </div>
    </ChatLinkActionsContext.Provider>
  );
}

/** Shell links use the focused task; task surfaces override this with their own browser. */
export function AppLinkActionsProvider({ children }: { children: ReactNode }) {
  const { settings } = useAppSettings();
  const { focusedThreadId, splitView } = useFocusedChatContext();
  const navigate = useNavigate();
  const actions: ChatLinkActions = {
    webLinkOpenTarget: settings.webLinkOpenTarget,
    githubLinkOpenTarget: settings.githubLinkOpenTarget,
    browserAvailable: isElectron && focusedThreadId !== null,
    openInBrowserPanel: (url) => {
      if (!focusedThreadId) {
        openExternalLink(url);
        return;
      }
      openLinkInBrowserPanel(url, focusedThreadId, () => {
        if (splitView) {
          useSplitViewStore.getState().setPanePanelState(splitView.id, splitView.focusedPaneId, {
            panel: "browser",
            hasOpenedPanel: true,
            lastOpenPanel: "browser",
          });
          return;
        }
        void navigate({
          to: "/$threadId",
          params: { threadId: focusedThreadId },
          replace: true,
          search: (previous) => ({ ...stripDiffSearchParams(previous), panel: "browser" }),
        });
      });
    },
  };
  return <LinkActionsProvider actions={actions}>{children}</LinkActionsProvider>;
}
