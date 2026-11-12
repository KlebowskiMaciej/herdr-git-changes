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
// copy. The copy may only read files, and answers in a sentence or two. When
// the person asks for something to be done, the copy ends its answer with a
// HANDOFF line, and the mod types that request into the terminal of the
// session it was copied from (`hc send`).
import { exec, hc, readTextFile, writeTextFile, panes, spaces } from "herdr";

export const COMMENTS_FILE = "git-changes-comments.json";
const ANSWER_TOOLS = "Read,Grep,Glob";
const HANDOFF = "HANDOFF:";
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

const handoffBlock = ({ to, text, error }) => (error
  ? { tone: "error", text: `Could not pass this to ${to}: ${error}` }
  : { tone: "handoff", text: `Passed to ${to}: ${text}` });

/**
 * What a thread shows, top to bottom: blocks of text with an optional label, in a
 * tone. An answered thread ends with a Reply box, unless the person is replying.
 */
export function threadBlocks(comment, { asking = false, failure = null, orphan = false, replying = false } = {}) {
  const blocks = [];
  if (orphan) blocks.push({ tone: "dim", text: `Line ${comment.line} is no longer in this diff: ${comment.text.trim()}`, single: true });
  for (const m of comment.thread) {
    blocks.push({ label: m.from === "you" ? "You" : "Claude", tone: m.from, text: m.text });
    if (m.handoff) blocks.push(handoffBlock(m.handoff));
  }
  if (asking) blocks.push({ label: "Claude", tone: "dim", text: "Thinking…", spinner: true });
  else if (failure) blocks.push({ tone: "error", text: failure });
  else if (awaitsAnswer(comment)) blocks.push({ tone: "dim", text: "No answer yet · right-click to ask again" });
  else if (!replying) blocks.push({ tone: "dim", text: "Reply…", single: true, reply: true });
  return blocks;
}

export const blockLines = (block, columns) => (block.label ? 1 : 0) + (block.single ? 1 : wrappedLines(block.text, columns));

/** The rule for asking for work, repeated with every message, because the copy follows the message more than its instructions. */
export function handoffReminder(origin) {
  if (!origin?.terminal) return "";
  return `\n\n(If this asks for work to be done, do not do it and do not offer to: say in one sentence that you passed it on, `
    + `and end with the line \`${HANDOFF} <the request>\` for the session "${origin.name ?? origin.session}". For a question, just answer.)`;
}

/** The first question to the forked session: where the comment is, the hunk around it, the comment, and the hand-off rule. */
export function questionPrompt(comment, question, origin = null) {
  return [
    "I left a review comment on a line of the current git diff. Answer it.",
    `File: ${comment.path}, line ${comment.line} (${KIND_NAMES[comment.kind]}): ${comment.text.trim()}`,
    "The diff around it:",
    "```diff", comment.context, "```",
    `My comment: ${question}`,
  ].join("\n") + handoffReminder(origin);
}

/** The instructions the copy gets on every turn: short answers, read only, and when to hand a request back to `origin`. */
export function answerStyle(origin) {
  const style = "You answer a review comment the person left on one line of a git diff, in a side thread next to that line. "
    + "Answer in one or two short sentences of plain text, with no headings or lists. Do not change any file.";
  if (!origin) return style;
  const name = origin.name ? `"${origin.name}" (${origin.session})` : origin.session;
  if (!origin.terminal) return `${style} You are a copy of the Claude Code session ${name}, which is not running now. `
    + "If the person asks for something to be done, say that the session must do it.";
  return `${style} You are a copy of the Claude Code session ${name}, which still runs in its own terminal and is responsible for this work. `
    + "You cannot change files, run commands or do the work yourself, and you never offer to. "
    + "When the person asks for something to be done (a change to the code, a rename, a fix, a test run), that session does it: "
    + `answer in one sentence that you passed it on, then end with one last line \`${HANDOFF} <the request, complete enough to act on without this thread>\`. `
    + `That line is typed into the session's terminal as it is. When the person only asks a question, answer it and add no ${HANDOFF} line.`;
}

/** `claude` arguments that send `prompt` to `session`, forked into a new session when `fork`. */
export function askArgs(prompt, session, fork, origin = null) {
  return ["-p", "--resume", session, ...(fork ? ["--fork-session"] : []), "--output-format", "json",
    "--tools", ANSWER_TOOLS, "--append-system-prompt", answerStyle(origin), "--", prompt];
}

/** Splits a trailing `HANDOFF: …` line off an answer; `handoff` is null without one. */
export function splitHandoff(answer) {
  const lines = answer.trimEnd().split("\n");
  const at = lines.findIndex((line) => line.trim().startsWith(HANDOFF));
  if (at < 0) return { text: answer.trim(), handoff: null };
  const handoff = lines.slice(at).join("\n").trim().slice(HANDOFF.length).trim();
  return { text: lines.slice(0, at).join("\n").trim(), handoff: handoff || null };
}

/** The answer and its session from `claude -p --output-format json`; throws with Claude's own message. */
export function parseAnswer({ code, stdout, stderr }) {
  let data;
  try { data = JSON.parse(stdout); } catch { throw new Error(stderr.trim() || stdout.trim() || `claude exited with ${code}`); }
  const out = Array.isArray(data) ? [...data].reverse().find((e) => e.type === "result") : data;
  if (!out || out.is_error || typeof out.result !== "string") throw new Error(out?.result || "Claude Code gave no answer");
  return { ...splitHandoff(out.result), session: out.session_id };
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
 * Where to look for the session to fork, most fitting first, as `{ cwd, pane }`:
 * the Claude Code terminals in the diff's space, then those inside the
 * repository, then the repository and its main checkout (a Claude Code session
 * that made a worktree keeps its sessions under the folder it started in).
 */
function sessionFolders(root, main, space) {
  const tabs = new Set(spaces().find((s) => s.id === space)?.tabs.map((t) => t.id) ?? []);
  const claude = panes().filter((p) => runsClaude(p) && p.cwd && p.terminal);
  const inSpace = claude.filter((p) => tabs.has(p.tab));
  const inRepository = claude.filter((p) => isInside(root, p.cwd) || isInside(main, p.cwd));
  const helper = inSpace[0] ?? inRepository[0] ?? null;
  return [
    inSpace.map((pane) => ({ cwd: pane.cwd, pane })),
    inRepository.map((pane) => ({ cwd: pane.cwd, pane })),
    [root, main].filter(Boolean).map((cwd) => ({ cwd, pane: claude.find((p) => p.cwd === cwd) ?? helper })),
  ];
}

const terminalName = (pane) => pane.title.replace(/^[^\p{L}\p{N}]+/u, "").trim() || pane.terminal;

/**
 * The session to fork, the folder it started in, and `origin`: that session with
 * the terminal it runs in, when known. Null when there is no session: the newest
 * session in the first group of `sessionFolders` that has one wins. Sessions in
 * `taken` (the copies threads made) are skipped.
 */
export async function findSession({ root, on, space, taken }) {
  const tiers = sessionFolders(root, await mainCheckout(root, on).catch(() => null), space)
    .map((folders) => new Map(folders.map((folder) => [projectDir(folder.cwd), folder])));
  const dirs = new Set(tiers.flatMap((tier) => [...tier.keys()]));
  const r = await exec("sh", ["-c", NEWEST_SESSIONS, "sh", ...dirs], { on });
  const newest = r.stdout.split("\n").map((line) => line.split("/"))
    .map(([dir, file]) => ({ dir, session: file?.replace(/\.jsonl$/, "") }))
    .filter(({ session }) => session && !taken.has(session));
  for (const tier of tiers) {
    const found = newest.find(({ dir }) => tier.has(dir));
    if (!found) continue;
    const { cwd, pane } = tier.get(found.dir);
    return { session: found.session, cwd, origin: { session: found.session, terminal: pane?.terminal ?? null, name: pane ? terminalName(pane) : null } };
  }
  return null;
}

/** Runs `claude` with its input closed: `claude -p` waits for an open input pipe to end before it answers. */
const runClaude = (args, cwd, on) => exec("sh", ["-c", RUN_CLAUDE, "sh", ...args], { cwd, on, timeout: ASK_TIMEOUT });

/** Types the copy's request into the original session's terminal; resolves with what the thread shows about it. */
async function passOn(origin, comment, request) {
  const to = origin.name ?? origin.session;
  const text = `Review comment on ${comment.path} line ${comment.line}, passed on from its thread in Git Changes: ${request}`;
  const r = await hc(["send", origin.terminal, text]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  return r.code === 0 ? { to, text: request } : { to, text: request, error: r.stderr.trim() || r.stdout.trim() || `hc exited with ${r.code}` };
}

/**
 * Sends the thread's open question to Claude Code, the copy the thread made or,
 * on the first question, a new fork. When the answer asks for work, passes it on
 * to the original session. Resolves with `{ message, session, cwd, origin }`.
 */
export async function askClaude(comment, source) {
  const question = lastFrom(comment, "you"), { root, on } = source;
  let found = comment.session ? { session: comment.session, cwd: comment.cwd, origin: comment.origin ?? null } : null;
  if (!found) found = await findSession(source);
  if (!found) throw new Error(`No Claude Code session found for ${root}. Start one there first.`);
  const fork = !comment.session;
  const prompt = fork ? questionPrompt(comment, question, found.origin) : question + handoffReminder(found.origin);
  const answer = parseAnswer(await runClaude(askArgs(prompt, found.session, fork, found.origin), found.cwd, on));
  const handoff = answer.handoff && found.origin?.terminal ? await passOn(found.origin, comment, answer.handoff) : null;
  const text = answer.text || (handoff ? "I passed this on." : "");
  return { message: { from: "claude", text, at: Date.now(), ...(handoff ? { handoff } : {}) }, session: answer.session, cwd: found.cwd, origin: found.origin };
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
export const withMessage = (id, message, fields = {}) => (list) => list.map((c) => (c.id === id ? { ...c, ...fields, thread: [...c.thread, message] } : c));
export const withoutComment =(id) => (list) => list.filter((c) => c.id !== id);
