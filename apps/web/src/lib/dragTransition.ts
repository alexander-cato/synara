function hasContainsMethod(value: unknown): value is { contains: (target: unknown) => boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "contains" in value &&
    typeof (value as { contains?: unknown }).contains === "function"
  );
}

/** Child-to-child drag events do not leave the enclosing drop target. */
export function isInternalDragTransition(currentTarget: unknown, relatedTarget: unknown): boolean {
  if (!relatedTarget || !hasContainsMethod(currentTarget)) return false;
  try {
    return currentTarget.contains(relatedTarget);
  } catch {
    return false;
  }
}
