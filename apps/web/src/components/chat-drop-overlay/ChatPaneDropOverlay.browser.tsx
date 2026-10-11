import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { beginThreadDrag, endThreadDrag, THREAD_DRAG_MIME } from "~/lib/threadDrag";
import { SurfaceContentTabs } from "../chat/SurfaceContentTabs";
import { ChatPaneDropOverlay } from "./ChatPaneDropOverlay";

describe("nested thread drop targets", () => {
  it("opens a dropped tab without leaving a split preview or splitting the pane", async () => {
    const onSplit = vi.fn();
    const onThreadDrop = vi.fn();
    const mounted = await render(
      <div className="flex gap-8 p-4">
        <button
          draggable
          onDragStart={(event) => beginThreadDrag(event, ThreadId.makeUnsafe("source"))}
          onDragEnd={endThreadDrag}
        >
          Source chat
        </button>
        <ChatPaneDropOverlay onDrop={onSplit} className="h-[300px] w-[500px]">
          <SurfaceContentTabs
            ariaLabel="Open threads"
            activeKey="open"
            onThreadDrop={onThreadDrop}
            tabs={[{ key: "open", title: "Open chat", icon: <span />, onSelect: vi.fn() }]}
          />
          <div className="flex-1">Transcript</div>
        </ChatPaneDropOverlay>
      </div>,
    );
    try {
      await userEvent.dragAndDrop(
        page.getByRole("button", { name: "Source chat", exact: true }),
        page.getByRole("navigation", { name: "Open threads" }),
      );
      expect(onThreadDrop).toHaveBeenCalledExactlyOnceWith("source");
      expect(onSplit).not.toHaveBeenCalled();
      expect(mounted.container.querySelector("[data-chat-pane-drop-zone]")).toBeNull();
    } finally {
      endThreadDrag();
      await mounted.unmount();
    }
  });

  it("clears a preview when cancelled or dropped onto a target that stops propagation", async () => {
    const onSplit = vi.fn();
    const mounted = await render(
      <div>
        <ChatPaneDropOverlay onDrop={onSplit} className="h-[300px] w-[500px]">
          Transcript
        </ChatPaneDropOverlay>
        <button onDrop={(event) => event.stopPropagation()}>Other target</button>
      </div>,
    );
    try {
      const pane = mounted.container.querySelector<HTMLElement>("[data-chat-pane-drop-overlay]")!;
      const rect = pane.getBoundingClientRect();
      const transfer = new DataTransfer();
      transfer.setData(THREAD_DRAG_MIME, '{"threadId":"source"}');
      const enter = () =>
        pane.dispatchEvent(
          new DragEvent("dragenter", {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX: rect.left + 1,
            clientY: rect.top + rect.height / 2,
          }),
        );
      enter();
      expect(pane.querySelector("[data-chat-pane-drop-zone]")).not.toBeNull();
      window.dispatchEvent(new DragEvent("dragend"));
      expect(pane.querySelector("[data-chat-pane-drop-zone]")).toBeNull();
      enter();
      expect(pane.querySelector("[data-chat-pane-drop-zone]")).not.toBeNull();
      page
        .getByRole("button", { name: "Other target" })
        .element()
        .dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      expect(pane.querySelector("[data-chat-pane-drop-zone]")).toBeNull();
      expect(onSplit).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
