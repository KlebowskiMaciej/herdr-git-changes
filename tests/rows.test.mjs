// Tests the list's row model, where a click lands in a row, and reading an image's
// size from its own bytes. Nothing here needs Herdr or git. Run: node tests/rows.test.mjs
import { buildRows, zoneAt, zoneCenter, filesInside, ACTION, BOX } from "../mods/git-changes/rows.js";
import { imageSize, fitSize, formatBytes } from "../mods/git-changes/imageinfo.js";
import { png, gif, jpeg, webpLossless, svgText } from "./fixtures.mjs";
import assert from "node:assert/strict";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); process.exitCode = 1; }
};

const file = (path, extra = {}) => ({ path, status: "M", staged: "none", area: "file", add: 1, del: 0, ...extra });
const model = (over = {}) => buildRows({
  entries: [file("src/ui/a.ts"), file("src/ui/b.ts", { staged: "all" }), file("src/c.ts"), file("README.md"), file("n.md", { untracked: true, status: "A" })],
  stashes: [{ ref: "stash@{0}", subject: "wip", when: "1d", area: "stash" }],
  listMode: "tree", folded: new Set(), collapsed: {}, ...over,
});
const shape = (rows) => rows.map((r) => `${r.type}:${r.type === "file" ? r.entry.path : r.type === "stash" ? r.stash.ref : r.type === "folder" ? r.path : r.area}@${r.depth ?? ""}`);

// --- the rows --------------------------------------------------------------------------

test("the tree: sections, merged folders, folders before files, stashes last", () => {
  assert.deepEqual(shape(model().rows), [
    "section:tracked@", "folder:src@0", "folder:src/ui@1", "file:src/ui/a.ts@2", "file:src/ui/b.ts@2", "file:src/c.ts@1", "file:README.md@0",
    "section:untracked@", "file:n.md@0", "section:stash@", "stash:stash@{0}@",
  ]);
});

test("flat: every file under its section, with its folder", () => {
  const rows = model({ listMode: "flat" }).rows;
  assert.deepEqual(rows.filter((r) => r.type === "file").map((r) => [r.entry.path, r.name, r.dir]), [
    ["src/ui/a.ts", "a.ts", "src/ui"], ["src/ui/b.ts", "b.ts", "src/ui"], ["src/c.ts", "c.ts", "src"], ["README.md", "README.md", ""], ["n.md", "n.md", ""],
  ]);
  assert.ok(!rows.some((r) => r.type === "folder"));
});

test("a folded folder or a collapsed section hides what's inside", () => {
  const folded = shape(model({ folded: new Set(["tracked:src/ui"]) }).rows);
  assert.ok(folded.includes("folder:src/ui@1") && !folded.includes("file:src/ui/a.ts@2"));
  const collapsed = shape(model({ collapsed: { tracked: true, stash: true } }).rows);
  assert.deepEqual(collapsed, ["section:tracked@", "section:untracked@", "file:n.md@0", "section:stash@"]);
});

test("a folder knows how much of it is staged, and the files inside it", () => {
  const { rows } = model();
  const by = (key) => rows.find((r) => r.key === key);
  assert.equal(by("folder:tracked:src/ui").staged, "some");
  assert.equal(by("folder:tracked:src").staged, "some");
  assert.equal(by("folder:tracked:src").files, 3);
  assert.deepEqual(filesInside(by("folder:tracked:src")).map((e) => e.path), ["src/ui/a.ts", "src/ui/b.ts", "src/c.ts"]);
  assert.equal(by("section:tracked").staged, "some");
  assert.equal(by("section:untracked").staged, "none");
});

test("every row has its own key, and the keys find the rows", () => {
  const { rows, byKey } = model();
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
  assert.equal(byKey.get("file:src/c.ts").entry.path, "src/c.ts");
  assert.equal(byKey.get("stash:stash@{0}").stash.subject, "wip");
});

test("no changes and no stashes: no rows", () => {
  assert.deepEqual(buildRows({ entries: [], stashes: [], listMode: "tree", folded: new Set(), collapsed: {} }).rows, []);
});

// --- where a click lands -----------------------------------------------------------------

const WIDTH = 400;
const rowFor = (key) => model().byKey.get(key);

test("a file row: the checkbox at its depth, the trash button at the right edge, the rest opens the diff", () => {
  const shallow = rowFor("file:README.md"), deep = rowFor("file:src/ui/a.ts");
  assert.equal(zoneAt(shallow, zoneCenter(shallow, "stage", WIDTH), WIDTH), "stage");
  assert.equal(zoneAt(deep, zoneCenter(deep, "stage", WIDTH), WIDTH), "stage");
  assert.equal(zoneAt(shallow, zoneCenter(deep, "stage", WIDTH), WIDTH), "body", "a deeper checkbox is not where a shallow one is");
  assert.equal(zoneAt(deep, zoneCenter(deep, "discard", WIDTH), WIDTH), "discard");
  assert.equal(zoneAt(deep, WIDTH / 2, WIDTH), "body");
});

test("a folder row: its checkbox stages, everything else folds", () => {
  const folder = rowFor("folder:tracked:src/ui");
  assert.equal(zoneAt(folder, zoneCenter(folder, "stage", WIDTH), WIDTH), "stage");
  assert.equal(zoneAt(folder, WIDTH - 10, WIDTH), "body");
});

test("a section: the checkbox left of the count stages, the title folds; a stash section has no checkbox", () => {
  const tracked = rowFor("section:tracked"), stash = rowFor("section:stash");
  assert.equal(zoneAt(tracked, zoneCenter(tracked, "stage", WIDTH), WIDTH), "stage");
  assert.equal(zoneAt(tracked, 30, WIDTH), "body");
  assert.equal(zoneAt(stash, zoneCenter(tracked, "stage", WIDTH), WIDTH), "body");
});

test("a stash row: three buttons from the right, drop, pop, apply, and nothing overlaps", () => {
  const stash = rowFor("stash:stash@{0}");
  for (const zone of ["drop", "pop", "apply"]) assert.equal(zoneAt(stash, zoneCenter(stash, zone, WIDTH), WIDTH), zone);
  assert.equal(zoneAt(stash, 100, WIDTH), "body");
  const hits = (zone) => Array.from({ length: WIDTH }, (_, x) => x).filter((x) => zoneAt(stash, x, WIDTH) === zone);
  assert.ok(Math.max(...hits("apply")) < Math.min(...hits("pop")) && Math.max(...hits("pop")) < Math.min(...hits("drop")));
});

test("each control is wide enough to hit: a button's whole face, and a few pixels around the checkbox", () => {
  const row = rowFor("file:README.md");
  const hits = (zone) => Array.from({ length: WIDTH }, (_, x) => x).filter((x) => zoneAt(row, x, WIDTH) === zone);
  assert.ok(hits("discard").length >= ACTION);
  assert.ok(hits("stage").length >= BOX);
});

test("a narrower or wider list moves the right-hand controls with it", () => {
  const row = rowFor("file:README.md");
  assert.equal(zoneAt(row, zoneCenter(row, "discard", 300), 300), "discard");
  assert.equal(zoneAt(row, zoneCenter(row, "discard", 300), 600), "body");
});

// --- images ---------------------------------------------------------------------------------

test("image size is read from the bytes of a PNG, GIF, JPEG, lossless WebP and SVG", () => {
  assert.deepEqual(imageSize(png(7, 5, [1, 2, 3]), "png"), { width: 7, height: 5 });
  assert.deepEqual(imageSize(gif(33, 21), "gif"), { width: 33, height: 21 });
  assert.deepEqual(imageSize(jpeg(640, 480), "jpg"), { width: 640, height: 480 });
  assert.deepEqual(imageSize(jpeg(640, 480), "jpeg"), { width: 640, height: 480 });
  assert.deepEqual(imageSize(webpLossless(300, 200), "webp"), { width: 300, height: 200 });
  assert.deepEqual(imageSize(Buffer.from(svgText(20, 10)), "svg"), { width: 20, height: 10 });
});

test("an SVG without width and height is sized by its viewBox; without either, it has no size", () => {
  assert.deepEqual(imageSize(Buffer.from('<svg viewBox="0 0 48 24" xmlns="x"></svg>'), "svg"), { width: 48, height: 24 });
  assert.deepEqual(imageSize(Buffer.from('<svg width="12px" height="6" xmlns="x"></svg>'), "svg"), { width: 12, height: 6 });
  assert.equal(imageSize(Buffer.from('<svg width="100%" height="100%"></svg>'), "svg"), null);
  assert.equal(imageSize(Buffer.from("not an image"), "png"), null);
  assert.equal(imageSize(Buffer.alloc(3), "gif"), null);
});

test("an image is scaled down to fit, never up, with its proportions kept", () => {
  assert.deepEqual(fitSize({ width: 16, height: 16 }, 400, 300), { width: 16, height: 16 });
  assert.deepEqual(fitSize({ width: 1000, height: 500 }, 400, 400), { width: 400, height: 200 });
  assert.deepEqual(fitSize({ width: 500, height: 1000 }, 400, 400), { width: 200, height: 400 });
});

test("file sizes read as people write them", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(3482), "3.4 KB");
  assert.equal(formatBytes(120 * 1024), "120 KB");
  assert.equal(formatBytes(5.5 * 1024 * 1024), "5.5 MB");
});

console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
