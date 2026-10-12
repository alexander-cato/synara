import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
export const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
export const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
};
export function expandHome(value: string, home: string): string {
  return path.resolve(
    value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value,
  );
}

const ignored = new Set([".git", ".DS_Store", "__pycache__"]);
export const excludedSkillDirectory = (name: string): boolean =>
  ignored.has(name) ||
  [".archived", "archive", "archives", ".state", "node_modules"].includes(name.toLowerCase());

/** Device/inode identity also folds case aliases on case-insensitive volumes. */
export async function fileIdentity(target: string): Promise<string> {
  const stat = await fs.stat(target);
  return `${stat.dev}:${stat.ino}`;
}

export async function walkSkillManifests(
  root: string,
  options: { followSymlinks?: boolean; includeMarkdownFiles?: boolean } = {},
): Promise<string[]> {
  const seen = new Set<string>();
  const manifests: string[] = [];
  let directories = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 16 || ++directories > 10000) return;
    try {
      const canonical = await fs.realpath(directory);
      if (canonical.split(path.sep).some(excludedSkillDirectory)) return;
      const stat = await fs.lstat(directory);
      if (stat.isSymbolicLink() && options.followSymlinks === false) return;
      const identity = await fileIdentity(directory);
      if (seen.has(identity)) return;
      seen.add(identity);
      const manifest = path.join(directory, "SKILL.md");
      const manifestStat = await (
        options.followSymlinks === false ? fs.lstat(manifest) : fs.stat(manifest)
      ).catch(() => null);
      if (manifestStat?.isFile()) {
        manifests.push(manifest);
        return;
      }
      const entries = (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (excludedSkillDirectory(entry.name)) continue;
        const child = path.join(directory, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          await walk(child, depth + 1);
        } else if (
          options.includeMarkdownFiles &&
          entry.isFile() &&
          entry.name.toLowerCase().endsWith(".md")
        ) {
          manifests.push(child);
        }
      }
    } catch (error) {
      // Missing roots, broken links, and permission-denied namespaces do not abort other roots.
      if (
        !["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  await walk(root, 0);
  return manifests;
}

/** Hash the entire package, including executable bits and binary assets. Never claim partial hashes are equal. */
export async function hashPackage(root: string): Promise<{ hash: string; files: string[] }> {
  const hash = createHash("sha256");
  const files: string[] = [];
  let totalBytes = 0;
  async function visit(
    target: string,
    relative: string,
    ancestors: ReadonlySet<string>,
    depth: number,
  ): Promise<void> {
    if (depth > 32 || files.length > 20000)
      throw new Error(`Package exceeds traversal limits: ${root}`);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const identity = `${stat.dev}:${stat.ino}`;
      if (ancestors.has(identity)) throw new Error(`Package contains a symlink cycle: ${target}`);
      const next = new Set([...ancestors, identity]);
      for (const entry of (await fs.readdir(target)).toSorted()) {
        if (!ignored.has(entry))
          await visit(
            path.join(target, entry),
            relative ? `${relative}/${entry}` : entry,
            next,
            depth + 1,
          );
      }
    } else if (stat.isFile()) {
      totalBytes += stat.size;
      if (totalBytes > 512 * 1024 * 1024) throw new Error(`Package exceeds 512 MB: ${root}`);
      files.push(relative || path.basename(target));
      hash.update(
        JSON.stringify([relative || path.basename(target), stat.mode & 0o111, stat.size]),
      );
      hash.update(await fs.readFile(target));
    } else throw new Error(`Unsupported package entry: ${target}`);
  }
  await visit(root, "", new Set(), 0);
  return { hash: hash.digest("hex"), files };
}

export async function packagePreview(root: string): Promise<string> {
  const { files } = await hashPackage(root);
  let preview = "";
  for (const file of files) {
    const target = path.join(root, file);
    const bytes = await fs.readFile(target);
    const stat = await fs.stat(target);
    const summary = `\n--- ${file} (${bytes.length} bytes, executable ${Boolean(stat.mode & 0o111)}) ---\n`;
    preview += summary;
    if (bytes.includes(0) || bytes.length > 128000 || preview.length + bytes.length > 500000)
      preview += `Binary or large asset: sha256 ${digest(bytes)}\n`;
    else preview += `${bytes.toString("utf8")}\n`;
  }
  return preview;
}

export interface FileSnapshot {
  readonly type: "missing" | "file" | "link" | "directory";
  readonly revision: string;
  readonly content: string;
  readonly mode: number;
}
export async function snapshot(target: string): Promise<FileSnapshot> {
  try {
    const stat = await fs.lstat(target);
    const type = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
    const content =
      type === "link"
        ? await fs.readlink(target)
        : type === "file"
          ? await fs.readFile(target, "utf8")
          : (await hashPackage(target)).hash;
    return {
      type,
      content,
      mode: stat.mode & 0o777,
      revision: digest(JSON.stringify([type, content, stat.mode & 0o777])),
    };
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { type: "missing", content: "", mode: 0o600, revision: "missing" };
  }
}

export async function atomicWrite(target: string, content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await fs.open(temporary, "wx", mode);
    try {
      // Creation applies the process umask; restoring native metadata requires the exact mode.
      await handle.chmod(mode);
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Resolve every existing parent, rejecting links that would redirect a declared export. */
export async function assertSafeTarget(target: string, home: string): Promise<void> {
  if (!isWithin(home, target) || target === home)
    throw new Error(`Export outside the personal home: ${target}`);
  const realHome = await fs.realpath(home);
  let parent = path.dirname(target);
  while (isWithin(home, parent)) {
    const actual = await fs.realpath(parent).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (actual) {
      const expectedParent = path.join(realHome, path.relative(home, parent));
      if (actual !== expectedParent && !isWithin(realHome, actual))
        throw new Error(`Export parent escapes the home: ${parent}`);
      // A provider root redirected to another provider is never an acceptable export target.
      if (actual !== expectedParent) throw new Error(`Export parent is a symlink: ${parent}`);
      return;
    }
    if (parent === home) break;
    parent = path.dirname(parent);
  }
}
