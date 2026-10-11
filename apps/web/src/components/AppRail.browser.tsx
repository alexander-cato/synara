import "../index.css";

import { ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { beginProjectDrag, PROJECT_SPACE_DRAG_MIME } from "~/lib/projectDrag";
import { AppRail, railItemGlyphs } from "./AppRail";

describe("pinned space project drops", () => {
  it("moves a dragged project to a pinned space without navigating", async () => {
    const onProjectDrop = vi.fn();
    const onSelect = vi.fn();
    const mounted = await render(
      <div className="flex gap-10 p-4">
        <button
          draggable
          onDragStart={(event) =>
            beginProjectDrag(event.dataTransfer, ProjectId.makeUnsafe("project-1"))
          }
        >
          Project
        </button>
        <AppRail
          items={[]}
          bottomItems={[]}
          shortcuts={[
            {
              id: "space:work",
              label: "Work",
              glyphs: railItemGlyphs("spaces"),
              active: false,
              badge: null,
              onSelect,
              onProjectDrop,
            },
          ]}
        />
      </div>,
    );
    try {
      await userEvent.dragAndDrop(
        page.getByRole("button", { name: "Project", exact: true }),
        page.getByRole("button", { name: "Work", exact: true }),
      );
      expect(onProjectDrop).toHaveBeenCalledExactlyOnceWith("project-1");
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps feedback across child transitions and clears it on cancellation", async () => {
    const onProjectDrop = vi.fn();
    const mounted = await render(
      <AppRail
        items={[]}
        bottomItems={[]}
        shortcuts={[
          {
            id: "space:void",
            label: "Void",
            glyphs: railItemGlyphs("spaces"),
            active: false,
            badge: null,
            onSelect: vi.fn(),
            onProjectDrop,
          },
        ]}
      />,
    );
    try {
      const button = page.getByRole("button", { name: "Void", exact: true }).element();
      const transfer = new DataTransfer();
      transfer.setData(PROJECT_SPACE_DRAG_MIME, '{"projectId":"project-1"}');
      const dispatch = (target: Element | Window, type: string) =>
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      dispatch(button, "dragenter");
      await expect.poll(() => button.classList.contains("ring-ring")).toBe(true);
      dispatch(button.firstElementChild!, "dragenter");
      dispatch(button, "dragleave");
      expect(button.classList.contains("ring-ring")).toBe(true);
      dispatch(window, "dragend");
      await expect.poll(() => button.classList.contains("ring-ring")).toBe(false);
      expect(onProjectDrop).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("ignores external and malformed drops", async () => {
    const onProjectDrop = vi.fn();
    const mounted = await render(
      <AppRail
        items={[]}
        bottomItems={[]}
        shortcuts={[
          {
            id: "space:work",
            label: "Work",
            glyphs: railItemGlyphs("spaces"),
            active: false,
            badge: null,
            onSelect: vi.fn(),
            onProjectDrop,
          },
        ]}
      />,
    );
    try {
      const button = page.getByRole("button", { name: "Work", exact: true }).element();
      for (const [type, value] of [
        ["text/plain", "project-1"],
        [PROJECT_SPACE_DRAG_MIME, '{"projectId":42}'],
      ]) {
        const transfer = new DataTransfer();
        transfer.setData(type!, value!);
        button.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
      }
      expect(onProjectDrop).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
