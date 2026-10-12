import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

/** Edit just a declared array field, retaining comments and unrelated configuration. */
export function appendConfigurationReference(
  content: string,
  format: "json" | "jsonc" | "toml",
  field: readonly string[],
  reference: string,
): string {
  if (!field.length || field.some((key) => ["__proto__", "prototype", "constructor"].includes(key)))
    throw new Error("Invalid configuration field.");
  let parsed: unknown;
  if (format === "toml") parsed = parseToml(content);
  else {
    const errors: ParseError[] = [];
    parsed = parse(content || "{}", errors, {
      allowTrailingComma: format === "jsonc",
      disallowComments: format === "json",
    });
    if (errors.length)
      throw new Error("Invalid native configuration; repair it before reconciliation.");
  }
  let value: unknown = parsed;
  for (const key of field)
    value =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
  )
    throw new Error("The declared native field is not a string array.");
  const current = (value ?? []) as string[];
  if (current.includes(reference)) return content;
  const next = [...current, reference];
  if (format !== "toml")
    return applyEdits(
      content || "{}\n",
      modify(content || "{}\n", [...field], next, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  // Grok's documented paths are a field in a TOML table. Replace only that field,
  // or append it to the table; never stringify credentials or unrelated settings.
  if (field.length !== 2 || field.some((key) => !/^[a-zA-Z0-9_-]+$/.test(key)))
    throw new Error("Unsupported TOML field conversion.");
  const [table, key] = field;
  const lines = content.split("\n");
  const header = lines.findIndex((line) => line.trim() === `[${table}]`);
  const replacement = `${key} = ${JSON.stringify(next)}`;
  if (header < 0) return `${content.trimEnd()}\n\n[${table}]\n${replacement}\n`;
  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end++;
  const assignment = lines.findIndex(
    (line, index) => index > header && index < end && new RegExp(`^\\s*${key}\\s*=`).test(line),
  );
  if (assignment < 0) lines.splice(end, 0, replacement);
  else {
    // A multi-line array can span several lines; replace only its syntactic extent.
    let last = assignment;
    let candidate = lines[assignment]!;
    while (last + 1 < end) {
      try {
        parseToml(`[${table}]\n${candidate}\n`);
        break;
      } catch {
        candidate += `\n${lines[++last]!}`;
      }
    }
    parseToml(`[${table}]\n${candidate}\n`);
    lines.splice(assignment, last - assignment + 1, replacement);
  }
  const result = lines.join("\n");
  parseToml(result);
  return result;
}
