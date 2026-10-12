import { ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  beginProjectDrag,
  isProjectDrag,
  PROJECT_SPACE_DRAG_MIME,
  readDraggedProjectId,
} from "./projectDrag";

describe("project drag contract", () => {
  it("writes a move payload and recognizes only project transfers", () => {
    const transfer = { effectAllowed: "none", setData: vi.fn() };
    beginProjectDrag(transfer as unknown as DataTransfer, ProjectId.makeUnsafe("project-1"));
    expect(transfer.effectAllowed).toBe("move");
    expect(transfer.setData).toHaveBeenCalledWith(
      PROJECT_SPACE_DRAG_MIME,
      '{"projectId":"project-1"}',
    );
    expect(isProjectDrag({ types: [PROJECT_SPACE_DRAG_MIME] })).toBe(true);
    expect(isProjectDrag({ types: ["Files", "text/plain", "application/x-synara-thread"] })).toBe(
      false,
    );
  });

  it.each(["", "{", "null", "[]", "42", "{}", '{"projectId":42}', '{"projectId":" "}'])(
    "ignores malformed payload %s",
    (raw) => expect(readDraggedProjectId({ getData: () => raw })).toBeNull(),
  );

  it("reads a valid project id", () => {
    expect(readDraggedProjectId({ getData: () => '{"projectId":"project-1"}' })).toBe("project-1");
  });
});
