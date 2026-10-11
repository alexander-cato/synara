// FILE: linkContextMenu.ts
// Purpose: Right-click menu shared by chat links (assistant markdown links and
//          link chips): open in the built-in review view or in-app browser, open in
//          the external browser, or copy the URL. Also resolves where a plain click on
//          any web link goes, including the independent GitHub review preference.
// Layer: Web UI helpers
// Exports: ChatLinkActionsContext, parseGitHubItemUrl, resolveGitHubItemLinkOpener,
//          resolveGitHubItemClickOpener, resolveLinkClickOpener, useLinkOpener,
//          showLinkContextMenu

import { isValidGitHubRepositoryNameWithOwner } from "@synara/shared/githubRepository";
import { createContext, useCallback, useContext } from "react";

import type { GitHubLinkOpenTarget, WebLinkOpenTarget } from "~/appSettings";
import { requireHttpExternalUrl } from "~/lib/externalUrl";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { openExternalLink } from "~/lib/linkChips";
import { readNativeApi } from "~/nativeApi";

/** In-app destinations a chat surface offers for the links it renders. */
export interface ChatLinkActions {
  /** Opens the URL in the thread's in-app browser panel. */
  readonly openInBrowserPanel: (url: string) => void;
  /** Opens a GitHub pull-request or issue URL in the built-in review view. */
  readonly openGitHubItem?: ((url: string) => void) | undefined;
  /** The user's setting for a plain click on a pull request or issue link. */
  readonly githubLinkOpenTarget?: GitHubLinkOpenTarget | undefined;
  readonly webLinkOpenTarget?: WebLinkOpenTarget | undefined;
  /** False in the web client or when there is no task browser to display. */
  readonly browserAvailable?: boolean | undefined;
}

export interface GitHubItemUrl {
  readonly kind: "pullRequest" | "issue";
  readonly repository: string;
  readonly number: number;
}

/** The pull request or issue a GitHub web URL points at, or null for any other URL. */
export function parseGitHubItemUrl(url: string | null | undefined): GitHubItemUrl | null {
  const match =
    /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i.exec(
      url?.trim() ?? "",
    );
  const repository = match?.[1] ?? "";
  const number = Number(match?.[3]);
  if (!isValidGitHubRepositoryNameWithOwner(repository) || !Number.isInteger(number)) return null;
  return {
    kind: match?.[2]?.toLowerCase() === "issues" ? "issue" : "pullRequest",
    repository,
    number,
  };
}

/** Shell defaults, overridden by the task's own browser and review destinations. */
export const ChatLinkActionsContext = createContext<ChatLinkActions | null>(null);

/** The built-in review opener for `url`, or undefined when it is not a pull request or issue. */
export function resolveGitHubItemLinkOpener(
  url: string,
  actions: ChatLinkActions | null,
): ((url: string) => void) | undefined {
  return actions?.openGitHubItem && parseGitHubItemUrl(url) ? actions.openGitHubItem : undefined;
}

/** Where a plain click on `url` goes under the user's setting, or undefined when it should
 *  stay external (not a pull request or issue, or the setting says external). */
export function resolveGitHubItemClickOpener(
  url: string,
  actions: ChatLinkActions | null,
): ((url: string) => void) | undefined {
  if (!actions || !parseGitHubItemUrl(url)) return undefined;
  const target = actions.githubLinkOpenTarget ?? "app";
  if (target === "external") return undefined;
  if (target === "app" && actions.openGitHubItem) return actions.openGitHubItem;
  return actions.browserAvailable === false ? undefined : actions.openInBrowserPanel;
}

export interface LinkClickModifiers {
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly button?: number;
}

/** Resolve one user click without changing file links, downloads, or custom protocols. */
export function resolveLinkClickOpener(
  url: string,
  actions: ChatLinkActions | null,
  event?: LinkClickModifiers,
): ((url: string) => void) | undefined {
  if (
    !actions ||
    event?.metaKey ||
    event?.ctrlKey ||
    event?.shiftKey ||
    event?.altKey ||
    (event?.button !== undefined && event.button !== 0)
  )
    return undefined;
  try {
    requireHttpExternalUrl(url);
  } catch {
    return undefined;
  }
  if (parseGitHubItemUrl(url)) return resolveGitHubItemClickOpener(url, actions);
  return actions.browserAvailable !== false &&
    (actions.webLinkOpenTarget ?? "browser") === "browser"
    ? actions.openInBrowserPanel
    : undefined;
}

/** Shared by buttons, chips, PDF annotations, and terminal callbacks. */
export function useLinkOpener(): (url: string, event?: LinkClickModifiers) => void {
  const actions = useContext(ChatLinkActionsContext);
  return useCallback(
    (url: string, event?: LinkClickModifiers) => {
      const opener = resolveLinkClickOpener(url, actions, event) ?? openExternalLink;
      opener(url);
    },
    [actions],
  );
}

// Falls back to a DOM menu outside the desktop app.
export async function showLinkContextMenu(input: {
  url: string;
  position: { x: number; y: number };
  actions: ChatLinkActions | null;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const { url, actions } = input;
  const openGitHubItem = resolveGitHubItemLinkOpener(url, actions);
  const openTargets = [
    ...(openGitHubItem
      ? [
          {
            id: "open-github-item",
            label:
              parseGitHubItemUrl(url)?.kind === "issue"
                ? "Issue in Synara"
                : "Pull request in Synara",
          },
        ]
      : []),
    ...(actions && actions.browserAvailable !== false
      ? [{ id: "open-in-browser", label: "In-app browser" }]
      : []),
    { id: "open-external", label: "External browser" },
  ];
  const clicked = await api.contextMenu.show(
    [
      ...(openTargets.length > 1
        ? [{ id: "open-link", label: "Open link", children: openTargets }]
        : [{ id: "open-external", label: "Open in external browser" }]),
      { id: "copy-link" as const, label: "Copy link", separatorBefore: true },
    ],
    input.position,
  );
  if (clicked === "open-github-item") {
    openGitHubItem?.(url);
    return;
  }
  if (clicked === "open-in-browser") {
    actions?.openInBrowserPanel(url);
    return;
  }
  if (clicked === "open-external") {
    openExternalLink(url);
    return;
  }
  if (clicked === "copy-link") {
    await copyTextToClipboard(url);
  }
}
