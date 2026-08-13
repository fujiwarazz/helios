import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ALWAYS_EXCLUDED = new Set([".git", ".helios", "node_modules"]);

export async function fingerprintWorkspace(root: string): Promise<string> {
  const files: string[] = [];
  await collectFiles(root, root, files);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function collectFiles(
  root: string,
  directory: string,
  files: string[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ALWAYS_EXCLUDED.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(root, absolute, files);
    else if (entry.isFile()) files.push(relative(root, absolute));
  }
}
