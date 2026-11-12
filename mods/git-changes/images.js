import { exec, appHome } from "herdr";
import { exists, mkdir, readFile, readdir, unlink } from "fs/promises";
import * as G from "./git.js";
import { imageSize, formatBytes } from "./imageinfo.js";

const CACHE = "data/git-changes/preview";
const MAX_BYTES = 10 * 1024 * 1024;
const KEPT_FILES = 300;
const BLOB_ID = /^[0-9a-f]{40,64}$/;
const COPY_BLOB = 'git cat-file blob "$1" > "$2.part" && mv -- "$2.part" "$2"';
const COPY_FILE = 'cp -- "$1" "$2.part" && mv -- "$2.part" "$2"';

const inFlight = new Map();
const cacheFolder = () => `${appHome()}/${CACHE}`;
const shell = (script, args, cwd) => exec("sh", ["-c", script, "sh", ...args], { cwd });
const git = (args, cwd) => exec("git", [...G.READ, ...args], { cwd });

async function blobOf(revs, root) {
  for (const rev of revs) {
    const r = await git(["rev-parse", "--verify", "-q", rev], root);
    const id = r.stdout.trim();
    if (r.code === 0 && BLOB_ID.test(id)) return id;
  }
  return null;
}

async function blobSource(side, root) {
  const id = await blobOf(side.revs, root);
  if (!id) return null;
  const size = await git(["cat-file", "-s", id], root);
  return { name: id, bytes: Number(size.stdout), script: COPY_BLOB, from: id };
}

async function fileSource(side, root) {
  const hash = await git(["hash-object", "--", side.worktree], root);
  if (hash.code !== 0 || !BLOB_ID.test(hash.stdout.trim())) return null;
  const size = await shell('wc -c < "$1"', [side.worktree], root);
  return { name: `wt-${hash.stdout.trim()}`, bytes: Number(size.stdout), script: COPY_FILE, from: side.worktree };
}

async function copyToCache(source, out, root) {
  await mkdir(cacheFolder(), { recursive: true });
  const r = await shell(source.script, [source.from, out], root);
  if (r.code !== 0) throw new Error(G.gitError(r));
}

async function cached(source, type, root) {
  const file = `${source.name}.${type}`, out = `${cacheFolder()}/${file}`;
  if (!(await exists(out))) await copyToCache(source, out, root);
  const bytes = await readFile(out);
  return { src: `${CACHE}/${file}`, size: imageSize(bytes, type), bytes: bytes.length };
}

function cachedOnce(source, type, root) {
  const key = `${source.name}.${type}`;
  if (!inFlight.has(key)) inFlight.set(key, cached(source, type, root).finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}

/**
 * One side of an image diff as `{ src, size, bytes }`, where `src` is a path `image()` can load
 * (the image is copied under the app's folder first). Resolves to null when that side has no
 * image, or `{ error }` when it can't be shown. Works on this computer only.
 */
export async function previewSide(side, type, { root, on }) {
  if (!side) return null;
  if (on) return { error: "Image preview works on this computer only" };
  try {
    const source = side.worktree ? await fileSource(side, root) : await blobSource(side, root);
    if (!source) return null;
    if (source.bytes > MAX_BYTES) return { error: `Too large to preview (${formatBytes(source.bytes)})` };
    return await cachedOnce(source, type, root);
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

/** The before and after previews of an image row of `item`'s diff. */
export async function previewImage(item, row, { root, on, hasHead }) {
  const sides = G.imageSides(item, row, hasHead);
  const [before, after] = await Promise.all([previewSide(sides.before, row.type, { root, on }), previewSide(sides.after, row.type, { root, on })]);
  return { before, after };
}

/** Empties the preview cache once it holds more than a few hundred files. */
export async function pruneCache() {
  const folder = cacheFolder();
  const names = await readdir(folder).catch(() => []);
  if (names.length > KEPT_FILES) await Promise.all(names.map((name) => unlink(`${folder}/${name}`).catch(() => null)));
}
