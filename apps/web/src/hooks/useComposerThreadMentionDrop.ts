// FILE: useComposerThreadMentionDrop.ts
// Purpose: Turn a thread row dropped on the composer into the same @mention the `@` menu inserts.
// Layer: Web composer hook
// Exports: useComposerThreadMentionDrop, canDropThreadMention

import { type ThreadId } from "@synara/contracts";
import { THREAD_MENTION_DROPZONE_ATTRIBUTE } from "~/lib/threadDrag";
import { useThreadDropTarget } from "./useThreadDropTarget";

// A chat cannot mention itself, so its own row must not light the composer up.
export function canDropThreadMention(input: {
  readonly disabled: boolean;
  readonly currentThreadId: ThreadId | null;
  readonly draggedThreadId: ThreadId | null;
}): boolean {
  if (input.disabled) return false;
  return input.draggedThreadId === null || input.draggedThreadId !== input.currentThreadId;
}

export function useComposerThreadMentionDrop(input: {
  readonly disabled?: boolean;
  readonly currentThreadId: ThreadId | null;
  readonly onDropThread: (threadId: ThreadId) => void;
}) {
  const { disabled = false, currentThreadId, onDropThread } = input;
  const { isThreadOver, threadDropProps } = useThreadDropTarget({
    disabled,
    canDropThread: (draggedThreadId) =>
      canDropThreadMention({ disabled, currentThreadId, draggedThreadId }),
    onDropThread,
  });

  return {
    isThreadDragOverComposer: isThreadOver,
    threadMentionDropzoneProps: {
      [THREAD_MENTION_DROPZONE_ATTRIBUTE]: "true",
      ...threadDropProps,
    },
  };
}
