export const Language = Object.freeze({ Script: "script", CSharp: "csharp", Html: "html" });

export const Token = Object.freeze({
  Plain: "plain", Comment: "comment", Keyword: "keyword", String: "string", Number: "number",
  Type: "type", Function: "function", Tag: "tag", Attribute: "attribute", Punctuation: "punctuation",
});

const State = Object.freeze({
  Unknown: "unknown", Code: "code", Comment: "comment", Template: "template", Verbatim: "verbatim",
  Tag: "tag", DoubleQuoted: "\"", SingleQuoted: "'",
});

const EXTENSIONS = {
  ts: Language.Script, tsx: Language.Script, mts: Language.Script, cts: Language.Script,
  js: Language.Script, jsx: Language.Script, mjs: Language.Script, cjs: Language.Script,
  cs: Language.CSharp,
  html: Language.Html, htm: Language.Html,
};

const SCRIPT_KEYWORDS = new Set(`abstract any as async await boolean break case catch class const constructor continue debugger declare default
  delete do else enum export extends false finally for from function if implements import in instanceof interface keyof let namespace never new
  null number of private protected public readonly return satisfies static string super switch symbol this throw true try type typeof undefined
  unknown var void while yield`.split(/\s+/));

const CSHARP_KEYWORDS = new Set(`abstract as async await base bool break byte case catch char checked class const continue decimal default delegate
  do double dynamic else enum event explicit extern false finally fixed float for foreach get goto if implicit in init int interface internal is
  lock long nameof namespace new null object operator out override params partial private protected public readonly record ref required return
  sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var
  virtual void volatile when where while with yield`.split(/\s+/));

const MAX_LENGTH = 1000;
const COMMENT_CONTINUATION = /^\s*\*/;
const LINE_COMMENT = /\/\/.*/y;
const NUMBER = /0x[\da-f_]+[a-z]*|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?[a-z]*/iy;
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const QUOTED = /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?/y;
const INTERPOLATED = /\$"(?:\\.|[^"\\])*"?/y;
const VERBATIM_START = /(?:\$@|@\$|@)"/y;
const VERBATIM_REST = /(?:""|[^"])*"?/y;
const TEMPLATE_REST = /(?:\\[\s\S]?|[^\\`])*`?/y;
const CALL = /\s*\(/y;
const TAG_OPEN = /<\/?(?=[A-Za-z!])/y;
const TAG_NAME = /[!A-Za-z][\w:.-]*/y;
const TAG_CLOSE = /\/?>/y;
const ATTRIBUTE = /[^\s=>/"']+/y;
const WHITESPACE = /\s+/y;
const TEXT = /[^<]+/y;

/** The language a file is colored as, or `null` when it is shown without syntax colors. */
export function languageOf(path) {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path ?? "")?.[1].toLowerCase();
  return EXTENSIONS[extension] ?? null;
}

const matchAt = (pattern, line, at) => {
  pattern.lastIndex = at;
  return pattern.exec(line)?.[0] ?? null;
};

class Scanner {
  constructor(line, state) {
    this.line = line; this.at = 0; this.state = state; this.parts = [];
  }

  get done() { return this.at >= this.line.length; }

  emit(kind, text) {
    this.parts.push({ kind, text });
    this.at += text.length;
  }

  take(pattern, kind) {
    const text = matchAt(pattern, this.line, this.at);
    if (!text) return false;
    this.emit(kind, text);
    return true;
  }

  takeUntil(end, kind) {
    const found = this.line.indexOf(end, this.at);
    const stop = found < 0 ? this.line.length : found + end.length;
    this.emit(kind, this.line.slice(this.at, stop));
    return found >= 0;
  }

  takeChar(kind = Token.Plain) { this.emit(kind, this.line[this.at]); }
}

function identifierKind(scanner, word, keywords) {
  if (keywords.has(word)) return Token.Keyword;
  if (matchAt(CALL, scanner.line, scanner.at + word.length) !== null) return Token.Function;
  return /^[A-Z]/.test(word) ? Token.Type : Token.Plain;
}

function scanOpenString(scanner, rest, closer) {
  const text = matchAt(rest, scanner.line, scanner.at) || scanner.line[scanner.at];
  scanner.emit(Token.String, text);
  if (text.endsWith(closer)) scanner.state = State.Code;
}

function scanCodeToken(scanner, language, keywords) {
  if (scanner.take(LINE_COMMENT, Token.Comment)) return;
  if (scanner.line.startsWith("/*", scanner.at)) { scanner.emit(Token.Comment, "/*"); scanner.state = State.Comment; return; }
  if (language === Language.Script && scanner.line[scanner.at] === "`") { scanner.takeChar(Token.String); scanner.state = State.Template; return; }
  if (language === Language.CSharp && scanner.take(VERBATIM_START, Token.String)) { scanner.state = State.Verbatim; return; }
  if (language === Language.CSharp && scanner.take(INTERPOLATED, Token.String)) return;
  if (scanner.take(QUOTED, Token.String) || scanner.take(NUMBER, Token.Number)) return;
  const word = matchAt(IDENTIFIER, scanner.line, scanner.at);
  if (word) scanner.emit(identifierKind(scanner, word, keywords), word);
  else scanner.takeChar();
}

function scanCode(line, state, language) {
  const keywords = language === Language.CSharp ? CSHARP_KEYWORDS : SCRIPT_KEYWORDS;
  const start = state === State.Unknown ? (COMMENT_CONTINUATION.test(line) ? State.Comment : State.Code) : state;
  const scanner = new Scanner(line, start);
  while (!scanner.done) {
    if (scanner.state === State.Comment) { if (scanner.takeUntil("*/", Token.Comment)) scanner.state = State.Code; }
    else if (scanner.state === State.Template) scanOpenString(scanner, TEMPLATE_REST, "`");
    else if (scanner.state === State.Verbatim) scanOpenString(scanner, VERBATIM_REST, "\"");
    else scanCodeToken(scanner, language, keywords);
  }
  return scanner;
}

function scanTagToken(scanner) {
  if (scanner.take(WHITESPACE, Token.Plain)) return;
  if (scanner.take(TAG_CLOSE, Token.Punctuation)) { scanner.state = State.Code; return; }
  const char = scanner.line[scanner.at];
  if (char === "=") scanner.takeChar(Token.Punctuation);
  else if (char === State.DoubleQuoted || char === State.SingleQuoted) { scanner.takeChar(Token.String); scanner.state = char; }
  else if (!scanner.take(ATTRIBUTE, Token.Attribute)) scanner.takeChar();
}

function scanTextToken(scanner) {
  if (scanner.line.startsWith("<!--", scanner.at)) { scanner.emit(Token.Comment, "<!--"); scanner.state = State.Comment; return; }
  if (scanner.take(TAG_OPEN, Token.Punctuation)) { scanner.take(TAG_NAME, Token.Tag); scanner.state = State.Tag; return; }
  if (!scanner.take(TEXT, Token.Plain)) scanner.takeChar();
}

function scanHtml(line, state) {
  const scanner = new Scanner(line, state === State.Unknown ? State.Code : state);
  while (!scanner.done) {
    if (scanner.state === State.Comment) { if (scanner.takeUntil("-->", Token.Comment)) scanner.state = State.Code; }
    else if (scanner.state === State.Tag) scanTagToken(scanner);
    else if (scanner.state === State.DoubleQuoted || scanner.state === State.SingleQuoted) { if (scanner.takeUntil(scanner.state, Token.String)) scanner.state = State.Tag; }
    else scanTextToken(scanner);
  }
  return scanner;
}

const SCANNERS = {
  [Language.Script]: (line, state) => scanCode(line, state, Language.Script),
  [Language.CSharp]: (line, state) => scanCode(line, state, Language.CSharp),
  [Language.Html]: scanHtml,
};

function mergeTokens(parts) {
  const tokens = [];
  for (const { kind, text } of parts) {
    const blank = tokens.length && !tokens.at(-1).text.trim() ? tokens.pop().text : "";
    const last = tokens.at(-1);
    if (last?.kind === kind) { last.text += blank + text; continue; }
    const trailing = last ? /\s*$/.exec(last.text)[0] : "";
    if (trailing) last.text = last.text.slice(0, -trailing.length);
    tokens.push({ kind, text: trailing + blank + text });
  }
  return tokens;
}

/**
 * Splits one line into colored tokens. `state` carries a block comment, string or tag over from the line before.
 * Whitespace always leads a token, so no token ends in spaces.
 */
export function tokenizeLine(line, language, state = State.Unknown) {
  const scanner = SCANNERS[language](line, state);
  return { tokens: mergeTokens(scanner.parts), state: scanner.state };
}

/**
 * Sets `tokens` on every code row of a diff (rows from G.diffRows with C.attachPaths).
 * Removed and added lines each continue their own side's state; a file or hunk header starts over.
 */
export function highlightRows(rows) {
  let before = State.Unknown, after = State.Unknown, path, language = null;
  for (const row of rows) {
    if (row.kind === "f" || row.kind === "@") { before = after = State.Unknown; continue; }
    if (row.path !== path) { path = row.path; language = languageOf(path); }
    if (!language || row.text.length > MAX_LENGTH) continue;
    if (row.kind === "-") ({ tokens: row.tokens, state: before } = tokenizeLine(row.text, language, before));
    else if (row.kind === "+") ({ tokens: row.tokens, state: after } = tokenizeLine(row.text, language, after));
    else if (row.kind === " ") { ({ tokens: row.tokens, state: after } = tokenizeLine(row.text, language, after)); before = after; }
  }
  return rows;
}

/** The theme color of each token kind. Plain text keeps the color of its row. */
export const syntaxColors = (t) => ({
  [Token.Comment]: t.dim, [Token.Keyword]: t.ansi5, [Token.String]: t.ansi3, [Token.Number]: t.ansi11,
  [Token.Type]: t.ansi6, [Token.Function]: t.ansi4, [Token.Tag]: t.ansi4, [Token.Attribute]: t.ansi6, [Token.Punctuation]: t.muted,
});
