// Tests the diff's syntax colors: which files get them and how a line splits into tokens.
// Nothing here needs Herdr or git. Run: node tests/syntax.test.mjs
import { languageOf, tokenizeLine, highlightRows, Language, Token } from "../mods/git-changes/syntax.js";
import assert from "node:assert/strict";

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`); process.exitCode = 1; }
};

const pairs = (line, language, state) => tokenizeLine(line, language, state).tokens.map(({ kind, text }) => [kind, text]);
const kindOf = (tokens, text) => tokens.find(([, t]) => t.trim() === text)?.[0];

test("a file's extension picks its language; others get no colors", () => {
  assert.equal(languageOf("src/app.component.ts"), Language.Script);
  assert.equal(languageOf("a/B.TSX"), Language.Script);
  assert.equal(languageOf("lib/x.mjs"), Language.Script);
  assert.equal(languageOf("Server/Program.cs"), Language.CSharp);
  assert.equal(languageOf("app/page.html"), Language.Html);
  assert.equal(languageOf("README.md"), null);
  assert.equal(languageOf("Makefile"), null);
  assert.equal(languageOf(undefined), null);
});

test("TypeScript: keywords, types, calls, strings, numbers and comments", () => {
  const tokens = pairs("  const total: Order = sum(items, 0x1F) + 'a' // done", Language.Script);
  assert.equal(tokens.map(([, t]) => t).join(""), "  const total: Order = sum(items, 0x1F) + 'a' // done", "nothing is lost");
  assert.equal(kindOf(tokens, "const"), Token.Keyword);
  assert.equal(kindOf(tokens, "Order"), Token.Type);
  assert.equal(kindOf(tokens, "sum"), Token.Function);
  assert.equal(kindOf(tokens, "0x1F"), Token.Number);
  assert.equal(kindOf(tokens, "'a'"), Token.String);
  assert.equal(kindOf(tokens, "// done"), Token.Comment);
});

test("whitespace leads a token and never ends one, and neighbours of one kind merge", () => {
  const tokens = pairs("  return  a + b;", Language.Script);
  assert.deepEqual(tokens, [[Token.Keyword, "  return"], [Token.Plain, "  a + b;"]]);
  for (const [, text] of tokens.slice(0, -1)) assert.equal(text, text.trimEnd());
});

test("C#: its own keywords, verbatim and interpolated strings, and XML doc comments", () => {
  const tokens = pairs("public async Task<int> Run() => await Get($\"id {x}\", @\"C:\\dir\");", Language.CSharp);
  assert.equal(kindOf(tokens, "public async"), Token.Keyword);
  assert.equal(kindOf(tokens, "Task"), Token.Type);
  assert.equal(kindOf(tokens, "Run"), Token.Function);
  assert.equal(kindOf(tokens, "$\"id {x}\""), Token.String);
  assert.equal(kindOf(tokens, "@\"C:\\dir\""), Token.String);
  assert.deepEqual(pairs("    /// <summary>Docs</summary>", Language.CSharp), [[Token.Comment, "    /// <summary>Docs</summary>"]]);
  assert.notEqual(kindOf(pairs("let x = 1;", Language.CSharp), "let"), Token.Keyword, "TypeScript keywords are not C# keywords");
});

test("HTML: tags, attributes, values, text and comments", () => {
  const tokens = pairs('<button class="primary" (click)="save()">Save</button> <!-- note -->', Language.Html);
  assert.deepEqual(tokens, [
    [Token.Punctuation, "<"], [Token.Tag, "button"], [Token.Attribute, " class"], [Token.Punctuation, "="], [Token.String, '"primary"'],
    [Token.Attribute, " (click)"], [Token.Punctuation, "="], [Token.String, '"save()"'], [Token.Punctuation, ">"], [Token.Plain, "Save"],
    [Token.Punctuation, "</"], [Token.Tag, "button"], [Token.Punctuation, ">"], [Token.Comment, " <!-- note -->"],
  ]);
});

test("a block comment, a template string and an HTML tag carry over to the next line", () => {
  const comment = tokenizeLine("/** Adds", Language.Script);
  assert.deepEqual(pairs(" * two numbers. */ add();", Language.Script, comment.state).slice(0, 2), [[Token.Comment, " * two numbers. */"], [Token.Function, " add"]]);
  const template = tokenizeLine("const s = `one", Language.Script);
  assert.deepEqual(pairs("two` + x", Language.Script, template.state)[0], [Token.String, "two`"]);
  const tag = tokenizeLine("<div", Language.Html);
  assert.deepEqual(pairs('  *ngIf="ok">', Language.Html, tag.state), [[Token.Attribute, "  *ngIf"], [Token.Punctuation, "="], [Token.String, '"ok"'], [Token.Punctuation, ">"]]);
});

test("a hunk that starts inside a doc comment reads its '*' lines as comment", () => {
  assert.deepEqual(pairs("   * @param x the input", Language.Script), [[Token.Comment, "   * @param x the input"]]);
});

test("a diff's rows: removed and added lines keep their own state, headers start over, other files stay plain", () => {
  const rows = highlightRows([
    { kind: "f", text: "a.ts" },
    { kind: "@", text: "@@ -1,2 +1,2 @@" },
    { kind: "-", path: "a.ts", text: "/* old" },
    { kind: "+", path: "a.ts", text: "const x = 1;" },
    { kind: "-", path: "a.ts", text: "still old */" },
    { kind: "+", path: "a.ts", text: "let y = 2;" },
    { kind: "f", text: "notes.md" },
    { kind: "+", path: "notes.md", text: "const z" },
    { kind: "+", path: "a.ts", text: "x".repeat(1001) },
  ]);
  assert.equal(rows[4].tokens[0].kind, Token.Comment, "the removed side is still in its comment");
  assert.equal(rows[5].tokens[0].kind, Token.Keyword, "the added side is not");
  assert.equal(rows[7].tokens, undefined, "a Markdown file keeps its plain diff colors");
  assert.equal(rows[8].tokens, undefined, "a very long line is not split");
});

console.log(`${passed} passed`);
