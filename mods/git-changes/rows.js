import * as G from "./git.js";

export const ROW = 26;
export const OUTER = 6;
export const BORDER = 1;
export const PAD = 6;
export const INDENT = 14;
export const BOX = 14;
export const ACTION = 22;
export const ACTION_GAP = 8;
export const COUNT = 32;
export const COUNT_GAP = 6;
export const START = 8;
const SLOP = 3;

export const SECTIONS = [["conflict", "Conflicts"], ["tracked", "Tracked"], ["untracked", "Untracked"], ["stash", "Stashes"]];

const stagedState = (list) => (list.every((e) => e.staged === "all") ? "all" : list.some((e) => e.staged !== "none") ? "some" : "none");

function groupOf(entries) {
  const groups = { conflict: [], tracked: [], untracked: [] };
  for (const e of entries) groups[e.conflict ? "conflict" : e.untracked ? "untracked" : "tracked"].push(e);
  return groups;
}

function fileRow(entry, depth, area) {
  const parts = entry.path.split("/"), name = parts.pop();
  return { type: "file", key: `file:${entry.path}`, area, entry, depth, name, dir: parts.join("/") };
}

function treeRows(area, list, folded) {
  const closed = new Set([...folded].filter((k) => k.startsWith(`${area}:`)).map((k) => k.slice(area.length + 1)));
  return G.fileTree(list, closed).map((r) => (r.kind === "folder"
    ? { type: "folder", key: `folder:${area}:${r.path}`, area, list, path: r.path, name: r.name, depth: r.depth, files: r.files, staged: r.staged, open: !closed.has(r.path) }
    : fileRow(r.entry, r.depth, area)));
}

function sectionRows(area, title, list, { listMode, folded, collapsed }) {
  const section = { type: "section", key: `section:${area}`, area, title, list, count: list.length, staged: area === "stash" ? "none" : stagedState(list), folded: Boolean(collapsed[area]) };
  if (section.folded) return [section];
  if (area === "stash") return [section, ...list.map((stash) => ({ type: "stash", key: `stash:${stash.ref}`, area, stash }))];
  if (listMode === "flat") return [section, ...list.map((entry) => fileRow(entry, 0, area))];
  return [section, ...treeRows(area, list, folded)];
}

/** Every visible row of the list, top to bottom, and the same rows by key. */
export function buildRows({ entries, stashes, listMode, folded, collapsed }) {
  const groups = { ...groupOf(entries), stash: stashes };
  const rows = SECTIONS.flatMap(([area, title]) => (groups[area].length ? sectionRows(area, title, groups[area], { listMode, folded, collapsed }) : []));
  return { rows, byKey: new Map(rows.map((row) => [row.key, row])) };
}

/** The files a folder row stands for. */
export const filesInside = (row) => row.list.filter((e) => e.path.startsWith(`${row.path}/`));

const leftOf = (row) => OUTER + BORDER + START + (row.depth ?? 0) * INDENT;
const rightOf = (width) => width - OUTER - BORDER - PAD;
const within = (x, from, size) => x >= from - SLOP && x <= from + size + SLOP;

function stashZone(x, width) {
  const edge = rightOf(width);
  const buttons = ["drop", "pop", "apply"];
  const found = buttons.find((_name, i) => within(x, edge - ACTION - i * (ACTION + ACTION_GAP), ACTION));
  return found ?? "body";
}

const ZONES = {
  file: (row, x, width) => (within(x, leftOf(row), BOX) ? "stage" : x >= rightOf(width) - ACTION - SLOP ? "discard" : "body"),
  folder: (row, x) => (within(x, leftOf(row), BOX) ? "stage" : "body"),
  section: (row, x, width) => (row.area !== "stash" && within(x, rightOf(width) - COUNT - COUNT_GAP - BOX, BOX) ? "stage" : "body"),
  stash: (_row, x, width) => stashZone(x, width),
};

/**
 * The control at `x` px from the list's left edge in a row `width` px wide: "stage", "discard",
 * "apply", "pop", "drop" or "body". A virtual list's rows can't hold click handlers: the list says
 * which row was clicked and the press says where, so this reads the measurements the rows are drawn with.
 */
export function zoneAt(row, x, width) {
  return ZONES[row.type](row, x, width);
}

/** The middle of a control, for the same measurements `zoneAt` reads. */
export function zoneCenter(row, zone, width) {
  const edge = rightOf(width);
  if (zone === "stage") return row.type === "section" ? edge - COUNT - COUNT_GAP - BOX / 2 : leftOf(row) + BOX / 2;
  if (zone === "discard") return edge - ACTION / 2;
  const slot = ["drop", "pop", "apply"].indexOf(zone);
  return edge - ACTION / 2 - slot * (ACTION + ACTION_GAP);
}
