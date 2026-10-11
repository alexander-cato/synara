import type { ProjectId } from "@synara/contracts";
import { useEffect, useRef, useState, type DragEvent } from "react";

import { isProjectDrag, readDraggedProjectId } from "~/lib/projectDrag";

/** Shared by Space tabs, pinned rail spaces, and the Spaces catalog. */
export function useProjectDropTarget(onProjectDrop: ((projectId: ProjectId) => void) | undefined) {
  const dragDepth = useRef(0);
  const [isProjectOver, setIsProjectOver] = useState(false);
  const enabled = onProjectDrop !== undefined;

  useEffect(() => {
    const reset = () => {
      dragDepth.current = 0;
      setIsProjectOver(false);
    };
    if (!enabled) {
      reset();
      return;
    }
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
    return () => {
      window.removeEventListener("dragend", reset);
      window.removeEventListener("drop", reset);
    };
  }, [enabled]);

  return {
    isProjectOver,
    projectDropProps: onProjectDrop
      ? {
          onDragEnter: (event: DragEvent<HTMLElement>) => {
            if (!isProjectDrag(event.dataTransfer)) return;
            event.preventDefault();
            dragDepth.current += 1;
            setIsProjectOver(true);
          },
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!isProjectDrag(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            if (!isProjectDrag(event.dataTransfer)) return;
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setIsProjectOver(false);
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            if (!isProjectDrag(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepth.current = 0;
            setIsProjectOver(false);
            const projectId = readDraggedProjectId(event.dataTransfer);
            if (projectId) onProjectDrop(projectId);
          },
        }
      : {},
  };
}
