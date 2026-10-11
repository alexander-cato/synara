import { useEffect, useState, type DragEvent } from "react";
import type { ThreadId } from "@synara/contracts";

import {
  getActiveThreadDragId,
  isThreadDragTransfer,
  readThreadDragPayload,
} from "~/lib/threadDrag";
import { isComposerDropzoneInternalDragTransition } from "./useComposerDropzone";

/** Native thread drops shared by composer mentions and opening chat tabs. */
export function useThreadDropTarget(input: {
  disabled?: boolean;
  canDropThread: (threadId: ThreadId | null) => boolean;
  onDropThread: (threadId: ThreadId) => void;
}) {
  const { disabled = false, canDropThread, onDropThread } = input;
  const [isThreadOver, setIsThreadOver] = useState(false);
  const onDragEnterOrOver = (event: DragEvent<HTMLElement>) => {
    if (
      disabled ||
      !isThreadDragTransfer(event.dataTransfer) ||
      !canDropThread(getActiveThreadDragId())
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsThreadOver(true);
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (
      !isThreadDragTransfer(event.dataTransfer) ||
      isComposerDropzoneInternalDragTransition(event.currentTarget, event.relatedTarget)
    )
      return;
    setIsThreadOver(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!isThreadDragTransfer(event.dataTransfer)) return;
    setIsThreadOver(false);
    const payload = readThreadDragPayload(event.dataTransfer);
    if (disabled || !payload || !canDropThread(payload.threadId)) return;
    event.preventDefault();
    event.stopPropagation();
    onDropThread(payload.threadId);
  };
  useEffect(() => {
    const reset = () => setIsThreadOver(false);
    if (disabled) {
      reset();
      return;
    }
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [disabled]);
  return {
    isThreadOver,
    threadDropProps: {
      onDragEnter: onDragEnterOrOver,
      onDragOver: onDragEnterOrOver,
      onDragLeave,
      onDrop,
    },
  };
}
