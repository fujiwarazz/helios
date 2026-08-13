import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ALWAYS_EXCLUDED = new Set([".git", ".helios"]);

export async function fingerprintWorkspace(root: string): Promise<string> {
  const files: string[] = [];
  const isGit = await pathExists(join(root, ".git"));
  await collectFiles(root, root, files, isGit);
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
  isGit: boolean,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ALWAYS_EXCLUDED.has(entry.name) || (!isGit && entry.name === "node_modules")) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(root, absolute, files, isGit);
    else if (entry.isFile()) files.push(relative(root, absolute));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return true;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
