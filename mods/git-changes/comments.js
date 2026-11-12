// Local review comments on diff lines, each one a thread answered by a copy of
// the Claude Code session working in the repository.
//
// A comment is pinned to a line by its file, its text and its number, so it
// follows the line when lines above it come or go. Comments live in the
// repository's git folder (git-changes-comments.json), never in the worktree
// and never on GitHub or GitLab.
//
// The first question forks the newest Claude Code session of the repository
// (`claude -p --resume <id> --fork-session`): the copy knows what that session
// knows, and the session itself is left as it was. Later replies resume the
// copy. The copy may only read files, and answers in a sentence or two.
import { exec, readTextFile, writeTextFile, panes, spaces } from "herdr";

export const COMMENTS_FILE = "git-changes-comments.json";
const ANSWER_TOOLS = "Read,Grep,Glob";
const ANSWER_STYLE = "You answer a review comment the person left on one line of a git diff, in a side thread next to that line. "
  + "Answer in one or two short sentences of plain text, with no headings or lists. Do not change any file.";
const ASK_TIMEOUT = 300000;
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
const RUN_CLAUDE = 'exec claude "$@" < /dev/null';
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

/** What a thread shows, top to bottom: blocks of text with an optional label, in a tone. */
export function threadBlocks(comment, { asking = false, failure = null, orphan = false } = {}) {
  const blocks = [];
  if (orphan) blocks.push({ tone: "dim", text: `Line ${comment.line} is no longer in this diff: ${comment.text.trim()}`, single: true });
  for (const m of comment.thread) blocks.push({ label: m.from === "you" ? "You" : "Claude", tone: m.from, text: m.text });
  if (asking) blocks.push({ label: "Claude", tone: "dim", text: "Thinking…", spinner: true });
  else if (failure) blocks.push({ tone: "error", text: failure });
  else if (awaitsAnswer(comment)) blocks.push({ tone: "dim", text: "No answer yet · right-click to ask again" });
  return blocks;
}

export const blockLines = (block, columns) => (block.label ? 1 : 0) + (block.single ? 1 : wrappedLines(block.text, columns));

/** The first question to the forked session: where the comment is, the hunk around it, and the comment. */
export function questionPrompt(comment, question) {
  return [
    "I left a review comment on a line of the current git diff. Answer it.",
    `File: ${comment.path}, line ${comment.line} (${KIND_NAMES[comment.kind]}): ${comment.text.trim()}`,
    "The diff around it:",
    "```diff", comment.context, "```",
    `My comment: ${question}`,
  ].join("\n");
}

/** `claude` arguments that send `prompt` to `session`, forked into a new session when `fork`. */
export function askArgs(prompt, session, fork) {
  return ["-p", "--resume", session, ...(fork ? ["--fork-session"] : []), "--output-format", "json",
    "--tools", ANSWER_TOOLS, "--append-system-prompt", ANSWER_STYLE, "--", prompt];
}

/** The answer and its session from `claude -p --output-format json`; throws with Claude's own message. */
export function parseAnswer({ code, stdout, stderr }) {
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error(stderr.trim() || stdout.trim() || `claude exited with ${code}`); }
  const out = Array.isArray(data) ? [...data].reverse().find((e) => e.type === "result") : data;
  if (!out || out.is_error || typeof out.result !== "string") throw new Error(out?.result || "Claude Code gave no answer");
  return { text: out.result.trim(), session: out.session_id };
}

/** Claude Code's folder name for the sessions started in `cwd`. */
export const projectDir = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

const runsClaude = (pane) => pane.app === "claude-code" || pane.program?.key === "claude";
const isInside = (root, dir) => Boolean(root && dir && (dir === root || dir.startsWith(`${root}/`)));

/** The main checkout of the repository at `root`, which differs from `root` in a linked worktree; null when unknown. */
async function mainCheckout(root, on) {
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, on });
  const common = r.code === 0 ? r.stdout.trim() : "";
  return common.endsWith("/.git") ? common.slice(0, -"/.git".length) : null;
}

/**
 * Where to look for the session to fork, most fitting first: the folders of the
 * Claude Code terminals in the diff's space, then those inside the repository,
 * then the repository and its main checkout (a Claude Code session that made a
 * worktree keeps its sessions under the folder it started in).
 */
function sessionFolders(root, main, space) {
  const tabs = new Set(spaces().find((s) => s.id === space)?.tabs.map((t) => t.id) ?? []);
  const claude = panes().filter((p) => runsClaude(p) && p.cwd);
  return [
    claude.filter((p) => tabs.has(p.tab)).map((p) => p.cwd),
    claude.filter((p) => isInside(root, p.cwd) || isInside(main, p.cwd)).map((p) => p.cwd),
    [root, main].filter(Boolean),
  ];
}

/**
 * The session to fork and the folder it started in, or null when there is none:
 * the newest session in the first group of `sessionFolders` that has one.
 * Sessions in `taken` (the copies threads made) are skipped.
 */
export async function findSession({ root, on, space, taken }) {
  const tiers = sessionFolders(root, await mainCheckout(root, on).catch(() => null), space)
    .map((folders) => new Map(folders.map((cwd) => [projectDir(cwd), cwd])));
  const dirs = new Set(tiers.flatMap((tier) => [...tier.keys()]));
  const r = await exec("sh", ["-c", NEWEST_SESSIONS, "sh", ...dirs], { on });
  const newest = r.stdout.split("\n").map((line) => line.split("/"))
    .map(([dir, file]) => ({ dir, session: file?.replace(/\.jsonl$/, "") }))
    .filter(({ session }) => session && !taken.has(session));
  for (const tier of tiers) {
    const found = newest.find(({ dir }) => tier.has(dir));
    if (found) return { session: found.session, cwd: tier.get(found.dir) };
  }
  return null;
}

/** Runs `claude` with its input closed: `claude -p` waits for an open input pipe to end before it answers. */
const runClaude = (args, cwd, on) => exec("sh", ["-c", RUN_CLAUDE, "sh", ...args], { cwd, on, timeout: ASK_TIMEOUT });

/** Sends the thread's open question to Claude Code and resolves with `{ text, session, cwd }`. */
export async function askClaude(comment, source) {
  const question = lastFrom(comment, "you"), { root, on } = source;
  if (comment.session) return { ...parseAnswer(await runClaude(askArgs(question, comment.session, false), comment.cwd, on)), cwd: comment.cwd };
  const found = await findSession(source);
  if (!found) throw new Error(`No Claude Code session found for ${root}. Start one there first.`);
  return { ...parseAnswer(await runClaude(askArgs(questionPrompt(comment, question), found.session, true), found.cwd, on)), cwd: found.cwd };
}

/** Deletes the session copy a thread made, so it leaves no trace in `claude --resume`. */
export async function removeSession(comment, on) {
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
export const withMessage = (id, message, session = {}) => (list) => list.map((c) => (c.id === id ? { ...c, ...session, thread: [...c.thread, message] } : c));
export const withoutComment =(id) => (list) => list.filter((c) => c.id !== id);
