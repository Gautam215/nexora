import "server-only";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function privateFileRoot(): string {
  const defaultDirectory = path.join(/*turbopackIgnore: true*/ process.cwd(), ".private-files");
  const root = path.resolve(/*turbopackIgnore: true*/ process.env.NEXORA_PRIVATE_FILE_DIR || defaultDirectory);
  const projectRoot = path.resolve(/*turbopackIgnore: true*/ process.cwd());
  const publicRoot = path.join(projectRoot, "public");
  if (
    root === path.parse(root).root ||
    root === projectRoot ||
    root === publicRoot ||
    root.startsWith(`${publicRoot}${path.sep}`)
  ) {
    throw new Error("Private file storage must use a dedicated directory outside public/");
  }
  return root;
}

async function ensurePrivateRoot(): Promise<string> {
  const root = privateFileRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Private file storage directory is invalid");
  }
  await chmod(root, 0o700);
  return root;
}

function objectPath(root: string, storageKey: string): string {
  if (!UUID_PATTERN.test(storageKey)) throw new Error("Invalid private file storage key");
  return path.join(/*turbopackIgnore: true*/ root, `${storageKey.toLowerCase()}.blob`);
}

export async function writePrivateFile(storageKey: string, bytes: Uint8Array): Promise<void> {
  const target = objectPath(await ensurePrivateRoot(), storageKey);
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(target).catch(() => undefined);
    throw error;
  }
  await handle.close();
}

export async function readPrivateFile(storageKey: string, maxBytes: number): Promise<Buffer> {
  const target = objectPath(await ensurePrivateRoot(), storageKey);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) {
      throw new Error("Private file object failed integrity checks");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function removePrivateFile(storageKey: string): Promise<void> {
  const target = objectPath(privateFileRoot(), storageKey);
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function listStalePrivateFileKeys(olderThan: Date): Promise<string[]> {
  const root = privateFileRoot();
  let entries;
  try {
    entries = await readdir(/*turbopackIgnore: true*/ root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Private file storage directory is invalid");
  }

  const keys: string[] = [];
  for (const entry of entries) {
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.blob$/i.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const filePath = path.join(/*turbopackIgnore: true*/ root, entry.name);
    const info = await lstat(filePath);
    if (info.isFile() && !info.isSymbolicLink() && info.mtime <= olderThan) keys.push(match[1]!);
  }
  return keys;
}
