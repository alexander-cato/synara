import type { ProjectId } from "@synara/contracts";

/** Native project drags are separate from external files and thread references. */
export const PROJECT_SPACE_DRAG_MIME = "application/x-synara-project";

export function beginProjectDrag(dataTransfer: DataTransfer, projectId: ProjectId): void {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(PROJECT_SPACE_DRAG_MIME, JSON.stringify({ projectId }));
}

export function isProjectDrag(dataTransfer: Pick<DataTransfer, "types">): boolean {
  return Array.from(dataTransfer.types).includes(PROJECT_SPACE_DRAG_MIME);
}

export function readDraggedProjectId(
  dataTransfer: Pick<DataTransfer, "getData">,
): ProjectId | null {
  try {
    const payload: unknown = JSON.parse(dataTransfer.getData(PROJECT_SPACE_DRAG_MIME));
    if (
      typeof payload === "object" &&
      payload !== null &&
      "projectId" in payload &&
      typeof payload.projectId === "string" &&
      payload.projectId.trim().length > 0
    ) {
      return payload.projectId as ProjectId;
    }
  } catch {
    return null;
  }
  return null;
}
