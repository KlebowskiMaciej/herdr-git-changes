// Local review comments on diff lines, each one a thread answered by a copy of
// the Claude Code session working in the repository.
//
// A comment is pinned to a line by its file, its text and its number, so it
// follows the line when lines above it come or go. Comments live in the
// repository's git folder (git-changes-comments.json), never in the worktree
// and never on GitHub or GitLab.
//
// The first question forks the Claude Code session of the repository into an
// interactive session of its own, started as a sub-agent of the original's
// terminal (`hc run --parent`, `claude --resume <id> --fork-session`) in the
// original's folder: it has the project's settings and permissions, can do the
// work it is asked for, and the original is left as it was. Its answers are
// read back from its session file; replies are typed into its terminal.
import { exec, hc, readTextFile, writeTextFile, panes, spaces, terminals } from "herdr";

export const COMMENTS_FILE = "git-changes-comments.json";
const FORK_PREFIX = "c0ffee00";
const FORK_LABEL = "git-changes";
const FORK_NAME = "review-";
const SESSION_STYLE = "This session is a copy of another one, opened for a review comment the person left on one line of a git diff. "
  + "Your answers show in a thread next to that line, so keep each one to one or two short sentences of plain text. "
  + "If the comment asks for work, do it, then say in one or two sentences what you did.";
const CONTEXT_LINES = 8;
const LINE_KINDS = new Set(["+", "-", " "]);
const KIND_NAMES = { "+": "added", "-": "removed", " ": "unchanged" };
const SESSION_ID = /^[0-9a-f-]{36}$/;
const PROJECT_DIR = /^[A-Za-z0-9-]+$/;
const CLAUDE_PROJECTS = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"';
const NEWEST_SESSIONS = `cd ${CLAUDE_PROJECTS} 2>/dev/null || exit 0
dirs="$*"; set --
for d in $dirs; do for f in "$d"/*.jsonl; do [ -f "$f" ] && set -- "$@" "$f"; done; done
[ "$#" -gt 0 ] && ls -t -- "$@"`;
const READ_SESSION_END = `cd ${CLAUDE_PROJECTS} && tail -c 1000000 -- "$1/$2.jsonl"`;
const REMOVE_SESSION =`cd ${CLAUDE_PROJECTS} 2>/dev/null && rm -rf -- "$1/$2.jsonl" "$1/$2"`;

export const isLine = (row) => LINE_KINDS.has(row?.kind) && Boolean(row.path);
export const linesOf = (row) => (row.kind === "pair" ? [...new Set([row.left, row.right])].filter(isLine) : isLine(row) ? [row] : []);
export const anchorOf = (row) => ({ path: row.path, kind: row.kind, line: row.number, text: row.text });
export const isAnchor = (row, anchor) => isLine(row) && row.path === anchor.path && row.kind === anchor.kind && row.number === anchor.line && row.text === anchor.text;
const lastFrom = (comment, from) => [...comment.thread].reverse().find((m) => m.from === from)?.text ?? null;
export const lastAnswer = (comment) => lastFrom(comment, "claude");
export const awaitsAnswer = (comment) => comment.thread.at(-1)?.from === "you";

/** Gives each diff line the path of its file: the item's own path, or the latest file header above it. */
export function attachPaths(rows, item) {
  let path = item.path ?? null;
  for (const row of rows) {
    if (row.kind === "f") path = row.text;
    else if (LINE_KINDS.has(row.kind)) row.path = path;
  }
  return rows;
}

/** The lines around `row` inside its hunk, as diff text, for the first question's prompt. */
export function contextOf(rows, row) {
  const at = rows.indexOf(row);
  if (at < 0) return `${row.kind}${row.text}`;
  const inHunk = (i) => i >= 0 && i < rows.length && LINE_KINDS.has(rows[i].kind);
  let start = at, end = at;
  while (at - start < CONTEXT_LINES && inHunk(start - 1)) start--;
  while (end - at < CONTEXT_LINES && inHunk(end + 1)) end++;
  return rows.slice(start, end + 1).map((r) => `${r.kind}${r.text}`).join("\n");
}

/**
 * Pins each comment to the diff line that holds its text, the nearest one to its
 * old line number, preferring the same kind (a committed `+` line comes back as
 * an unchanged one). `orphans` are comments on a shown file whose line is gone.
 */
export function placeComments(lineRows, comments) {
  const placed = new Map(), orphans = [];
  const paths = new Set(lineRows.map((r) => r.path));
  const nearest = (rows, line) => rows.reduce((best, r) => (!best || Math.abs(r.number - line) < Math.abs(best.number - line) ? r : best), null);
  for (const comment of [...comments].sort((a, b) => a.at - b.at)) {
    const same = lineRows.filter((r) => r.path === comment.path && r.text === comment.text);
    const row = nearest(same.filter((r) => r.kind === comment.kind), comment.line) ?? nearest(same, comment.line);
    if (row) placed.set(row, [...(placed.get(row) ?? []), comment]);
    else if (paths.has(comment.path)) orphans.push(comment);
  }
  return { placed, orphans };
}

/** How many lines `text` takes when wrapped at word breaks into `columns` characters. */
export function wrappedLines(text, columns) {
  const width = Math.max(10, columns);
  return text.split("\n").reduce((sum, paragraph) => {
    let lines = 1, used = 0;
    for (const word of paragraph.split(" ")) {
      if (used && used + 1 + word.length > width) { lines++; used = 0; }
      used += (used ? 1 : 0) + word.length;
      while (used > width) { lines++; used -= width; }
    }
    return sum + lines;
  }, 0);
}

/**
 * What a thread shows, top to bottom: blocks of text with an optional label, in a
 * tone. While a question waits, the last block says why: the session is starting,
 * working, or waiting for the person in its terminal. An answered thread ends
 * with a Reply box, unless the person is replying. `session` is the open
 * session's terminal record, if it runs.
 */
export function threadBlocks(comment, { asking = false, failure = null, orphan = false, replying = false, session = null } = {}) {
  const blocks = [];
  if (orphan) blocks.push({ tone: "dim", text: `Line ${comment.line} is no longer in this diff: ${comment.text.trim()}`, single: true });
  for (const m of comment.thread) blocks.push({ label: m.from === "you" ? "You" : "Claude", tone: m.from, text: m.text });
  if (asking) blocks.push({ label: "Claude", tone: "dim", text: comment.session ? "Sending…" : "Starting a copy of the session…", spinner: true });
  else if (failure) blocks.push({ tone: "error", text: failure });
  else if (awaitsAnswer(comment) && session?.status === "blocked") blocks.push({ tone: "error", text: "Waiting for you in its session · right-click → Open session" });
  else if (awaitsAnswer(comment)) blocks.push({ label: "Claude", tone: "dim", text: "Thinking…", spinner: true });
  else if (!replying) blocks.push({ tone: "dim", text: "Reply…", single: true, reply: true });
  if (session) blocks.push({ tone: "dim", text: `Session ${session.name} is open · right-click → Open session`, single: true });
  return blocks;
}

export const blockLines = (block, columns) => (block.label ? 1 : 0) + (block.single ? 1 : wrappedLines(block.text, columns));

/** The first message to the forked session: where the comment is, the hunk around it, and the comment. */
export function questionPrompt(comment, question) {
  return [
    "I left a review comment on a line of the current git diff.",
    `File: ${comment.path}, line ${comment.line} (${KIND_NAMES[comment.kind]}): ${comment.text.trim()}`,
    "The diff around it:",
    "```diff", comment.context, "```",
    `My comment: ${question}`,
  ].join("\n");
}

const sessionName = (comment) => `${FORK_NAME}${comment.id}`.slice(0, 32);
const isFork = (t) => Boolean(t.labels?.[FORK_LABEL]) || Boolean(t.name?.startsWith(FORK_NAME));

/** The terminal record (`hc ls`) of the thread's session, while it is open. */
export function sessionTerminal(comment, list = terminals()) {
  if (!comment.terminal) return null;
  const mine = (t) => t.labels?.[FORK_LABEL] === comment.id || t.name === sessionName(comment);
  return list.find((t) => t.address === comment.terminal && mine(t) && t.state === "live") ?? null;
}

/**
 * The last answer the session wrote after the question asked at `since` (ms), or
 * null while there is none: the text of the last assistant record after the
 * first prompt from then on, read from the end of the session's file.
 */
export function answerAfter(jsonl, since) {
  let asked = false, answer = null;
  for (const line of jsonl.split("\n")) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.isSidechain || record.isMeta) continue;
    const content = record.message?.content;
    const texts = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text) : [];
    if (record.type === "user" && texts.length && Date.parse(record.timestamp) >= since) { asked = true; answer = null; }
    else if (asked && record.type === "assistant" && texts.join("").trim()) answer = texts.join("\n").trim();
  }
  return answer;
}

/** Claude Code's folder name for the sessions started in `cwd`. */
export const projectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const forkTerminals = () => new Set(terminals().filter(isFork).map((t) => t.address));
const runsClaude = (pane) => pane.app === "claude-code" || pane.program?.key === "claude";
const isInside = (root, dir) => Boolean(root && dir && (dir === root || dir.startsWith(`${root}/`)));

/** The main checkout of the repository at `root`, which differs from `root` in a linked worktree; null when unknown. */
async function mainCheckout(root, on) {
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, on });
  const common = r.code === 0 ? r.stdout.trim() : "";
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
}

/**
 * Where to look for the session to fork, most fitting first, as `{ cwd, pane }`:
 * the Claude Code terminals in the diff's space, then those inside the
 * repository, then the repository and its main checkout (a Claude Code session
 * that made a worktree keeps its sessions under the folder it started in).
 */
function sessionFolders(root, main, space) {
  const tabs = new Set(spaces().find((s) => s.id === space)?.tabs.map((t) => t.id) ?? []), forks = forkTerminals();
  const claude = panes().filter((p) => runsClaude(p) && p.cwd && p.terminal && !forks.has(p.terminal));
  const inSpace = claude.filter((p) => tabs.has(p.tab));
  const inRepository = claude.filter((p) => isInside(root, p.cwd) || isInside(main, p.cwd));
  const helper = inSpace[0] ?? inRepository[0] ?? null;
  return [
    inSpace.map((pane) => ({ cwd: pane.cwd, pane })),
    inRepository.map((pane) => ({ cwd: pane.cwd, pane })),
    [root, main].filter(Boolean).map((cwd) => ({ cwd, pane: claude.find((p) => p.cwd === cwd) ?? helper })),
  ];
}

/**
 * The session to fork, the folder it started in, and the terminal it runs in
 * (null when none is known). Null when there is no session: the newest session
 * in the first group of `sessionFolders` that has one wins. Copies threads made
 * (`FORK_PREFIX`, or in `taken`) are skipped.
 */
export async function findSession({ root, on, space, taken }) {
  const tiers = sessionFolders(root, await mainCheckout(root, on).catch(() => null), space)
    .map((folders) => new Map(folders.map((folder) => [projectDir(folder.cwd), folder])));
  const dirs = new Set(tiers.flatMap((tier) => [...tier.keys()]));
  const r = await exec("sh", ["-c", NEWEST_SESSIONS, "sh", ...dirs], { on });
  const newest = r.stdout.split("\n").map((line) => line.split("/"))
    .map(([dir, file]) => ({ dir, session: file?.replace(/\.jsonl$/, "") }))
    .filter(({ session }) => session && !session.startsWith(FORK_PREFIX) && !taken.has(session));
  for (const tier of tiers) {
    const found = newest.find(({ dir }) => tier.has(dir));
    if (!found) continue;
    const { cwd, pane } = tier.get(found.dir);
    return { session: found.session, cwd, terminal: pane?.terminal ?? null };
  }
  return null;
}

const hexes = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
/** A new session id that marks the session as a thread's copy. */
export const forkId = () => `${FORK_PREFIX}-${hexes(4)}-4${hexes(3)}-8${hexes(3)}-${hexes(12)}`;

const failed = (r, what) => new Error(r.stderr?.trim() || r.stdout?.trim() || `${what} exited with ${r.code}`);

/** Starts `claude <claudeArgs> <prompt>` as a sub-agent of `parent` (when known) in `cwd`; resolves with its terminal's address. */
async function startSession(comment, { cwd, on, parent }, claudeArgs, prompt) {
  const r = await hc(["run", "--bg", "--json", "--cwd", cwd, ...(on ? ["--on", on] : []),
    "--name", sessionName(comment), "--label", `${FORK_LABEL}=${comment.id}`, "--no-notify", "--outlive-parent",
    ...(parent ? ["--parent", parent] : ["--no-parent"]),
    "--", "claude", ...claudeArgs, "--name", `Review: ${comment.path}:${comment.line}`, "--append-system-prompt", SESSION_STYLE, "--", prompt]);
  if (r.code !== 0) throw failed(r, "hc run");
  const address = JSON.parse(r.stdout).address;
  return on && !address.includes("/") ? `${on}/${address}` : address;
}

/**
 * Gets the thread's open question to its session: typed into the session's
 * terminal while it runs, else in a restarted session (`--resume` of the
 * thread's copy), or, on a thread's first question, in a new interactive fork of
 * the original session, started as its sub-agent. Resolves with the fields the
 * comment gets: `{ session, cwd, terminal }`, or `{ terminal }`, or nothing.
 */
export async function deliver(comment, source) {
  const question = lastFrom(comment, "you"), { root, on } = source;
  if (sessionTerminal(comment)) {
    const r = await hc(["send", comment.terminal, question]);
    if (r.code !== 0) throw failed(r, "hc send");
    return {};
  }
  if (comment.session) return { terminal: await startSession(comment, { cwd: comment.cwd, on, parent: comment.parent }, ["--resume", comment.session], question) };
  const found = await findSession(source);
  if (!found) throw new Error(`No Claude Code session found for ${root}. Start one there first.`);
  const session = forkId();
  const terminal = await startSession(comment, { cwd: found.cwd, on, parent: found.terminal },
    ["--resume", found.session, "--fork-session", "--session-id", session], questionPrompt(comment, question));
  return { session, cwd: found.cwd, terminal, parent: found.terminal, origin: found.session };
}

/** The session's answer to the thread's open question, or null while it has none. */
export async function readAnswer(comment, on) {
  const since = [...comment.thread].reverse().find((m) => m.from === "you")?.at ?? 0;
  const dir = projectDir(comment.cwd ?? "");
  if (!SESSION_ID.test(comment.session ?? "") || !PROJECT_DIR.test(dir)) return null;
  const r = await exec("sh", ["-c", READ_SESSION_END, "sh", dir, comment.session], { on });
  return r.code === 0 ? answerAfter(r.stdout, since) : null;
}

/** Ends the thread's session, if it runs, and deletes its files, so it leaves no trace in `claude --resume`. */
export async function removeSession(comment, on) {
  if (sessionTerminal(comment)) await hc(["kill", comment.terminal]).catch(() => null);
  if (!SESSION_ID.test(comment.session ?? "") || !comment.cwd) return;
  const dir = projectDir(comment.cwd);
  if (PROJECT_DIR.test(dir)) await exec("sh", ["-c", REMOVE_SESSION, "sh", dir, comment.session], { on }).catch(() => null);
}

/** The comments file of the repository at `root`, or null when its git folder can't be found. */
export async function commentsFile(root, on) {
  const r = await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, on });
  return r.code === 0 ? `${r.stdout.trim()}/${COMMENTS_FILE}` : null;
}

const parseComments = (text) => {
  try {
    const comments = JSON.parse(text)?.comments;
    return Array.isArray(comments) ? comments : [];
  } catch { return []; }
};

export async function loadComments(file, on) {
  return file ? parseComments(await readTextFile(file, { on }).catch(() => null)) : [];
}

/** Applies `change` to the comments on disk and resolves with the result; another tab's writes are kept. */
export async function updateComments(file, change) {
  for (let attempt = 0; ; attempt++) {
    const before = await readTextFile(file);
    const next = change(parseComments(before));
    try {
      await writeTextFile(file, `${JSON.stringify({ version: 1, comments: next }, null, 2)}\n`, before);
      return next;
    } catch (e) { if (attempt >= 2) throw e; }
  }
}

export const withComment = (comment) => (list) => [...list.filter((c) => c.id !== comment.id), comment];
export const withFields = (id, fields) => (list) => list.map((c) => (c.id === id ? { ...c, ...fields } : c));
export const withMessage =(id, message, fields = {}) => (list) => list.map((c) => (c.id === id ? { ...c, ...fields, thread: [...c.thread, message] } : c));
export const withoutComment =(id) => (list) => list.filter((c) => c.id !== id);
