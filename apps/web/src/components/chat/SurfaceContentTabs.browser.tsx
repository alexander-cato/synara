import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SurfaceContentTabs } from "./SurfaceContentTabs";
import { beginThreadDrag, endThreadDrag, THREAD_DRAG_MIME } from "~/lib/threadDrag";

const TITLES = [
  "Cambiar resolución de pantalla",
  "Ocultar chats archivados",
  "Revisar la cola de tareas",
  "Arreglar el menú de pestañas",
  "Medir el uso de contexto",
  "Mover la vista previa flotante",
];

function mountStrip(widthPx: number, onSelect: (key: string) => void) {
  return render(
    <div style={{ width: `${widthPx}px`, display: "flex" }}>
      <SurfaceContentTabs
        ariaLabel="Open threads"
        activeKey="tab-0"
        tabs={TITLES.map((title, index) => ({
          key: `tab-${index}`,
          title,
          icon: <span aria-hidden className="size-3.5" />,
          onSelect: () => onSelect(`tab-${index}`),
        }))}
      />
    </div>,
  );
}

describe("SurfaceContentTabs overflow", () => {
  it("keeps titles readable and lists tabs that do not fit in an overflow menu", async () => {
    const onSelect = vi.fn();
    const screen = await mountStrip(560, onSelect);
    try {
      const overflow = page.getByRole("button", { name: /more tabs?$/ });
      await expect.element(overflow).toBeVisible();
      // Each tab keeps its floor width instead of shrinking to a few letters.
      const tabWidths = Array.from(
        document.querySelectorAll<HTMLElement>("[data-surface-tab]"),
        (tab) => tab.getBoundingClientRect().width,
      );
      const fontSizePx = Number.parseFloat(
        getComputedStyle(document.querySelector<HTMLElement>("[data-surface-tab]")!).fontSize,
      );
      expect(Math.min(...tabWidths)).toBeGreaterThanOrEqual(fontSizePx * 12 - 1);

      await overflow.click();
      const lastTitle = TITLES.at(-1)!;
      await page.getByRole("menuitem", { name: lastTitle }).click();
      expect(onSelect).toHaveBeenCalledWith(`tab-${TITLES.length - 1}`);
    } finally {
      await screen.unmount();
    }
  });

  it("shows no overflow menu while every tab fits", async () => {
    const screen = await mountStrip(4000, () => {});
    try {
      await expect.element(page.getByRole("navigation", { name: "Open threads" })).toBeVisible();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(page.getByRole("button", { name: /more tabs?$/ }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});

describe("SurfaceContentTabs native thread drops", () => {
  it("accepts a sidebar thread without reordering tabs or selecting the tab under the pointer", async () => {
    const onThreadDrop = vi.fn();
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const mounted = await render(
      <div className="flex w-[700px] gap-8 p-4">
        <button
          draggable
          onDragStart={(event) => beginThreadDrag(event, ThreadId.makeUnsafe("dropped"))}
          onDragEnd={endThreadDrag}
        >
          Saved chat
        </button>
        <SurfaceContentTabs
          ariaLabel="Open threads"
          activeKey="open"
          onMove={onMove}
          onThreadDrop={onThreadDrop}
          tabs={[{ key: "open", title: "Open chat", icon: <span />, onSelect }]}
        />
      </div>,
    );
    try {
      await userEvent.dragAndDrop(
        page.getByRole("button", { name: "Saved chat", exact: true }),
        page.getByRole("button", { name: "Open chat", exact: true }),
      );
      expect(onThreadDrop).toHaveBeenCalledExactlyOnceWith("dropped");
      expect(onMove).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      endThreadDrag();
      await mounted.unmount();
    }
  });

  it("clears feedback on cancellation and rejects malformed, unrelated, and ineligible drops", async () => {
    const onThreadDrop = vi.fn();
    const mounted = await render(
      <SurfaceContentTabs
        ariaLabel="Open threads"
        activeKey="open"
        onThreadDrop={onThreadDrop}
        canDropThread={(threadId) => threadId === null || threadId === "allowed"}
        tabs={[{ key: "open", title: "Open chat", icon: <span />, onSelect: vi.fn() }]}
      />,
    );
    try {
      const target = page.getByRole("navigation", { name: "Open threads" }).element();
      const transfer = new DataTransfer();
      transfer.setData(THREAD_DRAG_MIME, '{"threadId":"allowed"}');
      target.dispatchEvent(
        new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      await expect.poll(() => target.classList.contains("ring-ring")).toBe(true);
      window.dispatchEvent(new DragEvent("dragend"));
      await expect.poll(() => target.classList.contains("ring-ring")).toBe(false);
      for (const [type, value] of [
        [THREAD_DRAG_MIME, "null"],
        [THREAD_DRAG_MIME, '{"threadId":"archived"}'],
        ["text/plain", "allowed"],
      ]) {
        const rejected = new DataTransfer();
        rejected.setData(type!, value!);
        target.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: rejected }),
        );
      }
      expect(onThreadDrop).not.toHaveBeenCalled();
      expect(target.hasAttribute("data-thread-mention-dropzone")).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });
});
