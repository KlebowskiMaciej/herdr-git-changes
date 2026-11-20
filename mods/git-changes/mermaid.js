import { exec } from "herdr";
import { exists, mkdir, readFile, unlink, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { CACHE, cacheFolder } from "./images.js";
import { imageSize } from "./imageinfo.js";

export const Part = Object.freeze({ Markdown: "markdown", Mermaid: "mermaid" });

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const MERMAID = "mermaid";
const SCALE = 2, TIMEOUT_MS = 30000, NOT_FOUND = 127, DARK_LUMINANCE = 128;
export const INSTALL_HINT = "Install the Mermaid CLI to see this diagram: npm install -g @mermaid-js/mermaid-cli";

const closes = (line, fence) => {
  const close = CLOSE_FENCE.exec(line)?.[1];
  return Boolean(close) && close[0] === fence[0] && close.length >= fence.length;
};

/** `text` cut into its Markdown parts and the Mermaid diagrams between them, in order. A `mermaid` fence inside another fence stays text. */
export function splitMermaid(text) {
  const parts = [];
  let markdown = [], fence = null, diagram = null;
  const endMarkdown = () => {
    if (markdown.some((line) => line.trim())) parts.push({ kind: Part.Markdown, text: markdown.join("\n") });
    markdown = [];
  };
  for (const line of text.split("\n")) {
    if (diagram && !closes(line, fence)) { diagram.push(line); continue; }
    if (diagram) { parts.push({ kind: Part.Mermaid, source: diagram.join("\n") }); diagram = null; fence = null; continue; }
    const open = fence ? null : OPEN_FENCE.exec(line);
    if (open?.[2].toLowerCase() === MERMAID) { endMarkdown(); fence = open[1]; diagram = []; continue; }
    if (fence && closes(line, fence)) fence = null;
    else if (open) fence = open[1];
    markdown.push(line);
  }
  if (diagram) parts.push({ kind: Part.Mermaid, source: diagram.join("\n") });
  endMarkdown();
  return parts;
}

/** Whether a `#rrggbb` color is dark; false for anything else. */
export function isDarkColor(color) {
  const rgb = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color ?? "");
  if (!rgb) return false;
  const [r, g, b] = rgb.slice(1).map((hex) => parseInt(hex, 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < DARK_LUMINANCE;
}

export const diagramKey = (source, dark) => createHash("sha256").update(`${dark ? "dark" : "default"}\n${source}`).digest("hex").slice(0, 32);

const failureOf = (result) => {
  if (result.code === NOT_FOUND || result.code === null) return INSTALL_HINT;
  return (result.stderr ?? "").split("\n").find((line) => line.trim()) ?? `mmdc stopped with code ${result.code}`;
};

async function runMermaid(source, dark, out) {
  const input = out.replace(/\.png$/, ".mmd");
  await mkdir(cacheFolder(), { recursive: true });
  await writeFile(input, source);
  try {
    const args = ["-q", "-i", input, "-o", out, "-t", dark ? "dark" : "default", "-b", "transparent", "-s", String(SCALE)];
    const result = await exec("mmdc", args, { timeout: TIMEOUT_MS });
    return result.code === 0 ? null : failureOf(result);
  } catch { return INSTALL_HINT; }
  finally { await unlink(input).catch(() => null); }
}

async function draw(source, dark) {
  const name = `mermaid-${diagramKey(source, dark)}.png`, out = `${cacheFolder()}/${name}`;
  if (!(await exists(out))) {
    const error = await runMermaid(source, dark, out);
    if (error) return { error };
  }
  const size = imageSize(await readFile(out), "png");
  if (!size) return { error: "The Mermaid CLI wrote no picture" };
  return { src: `${CACHE}/${name}`, size: { width: Math.round(size.width / SCALE), height: Math.round(size.height / SCALE) } };
}

let queue = Promise.resolve();

/**
 * The diagram drawn by the Mermaid CLI (`mmdc`) as a PNG under the app's folder: `{ src, size }`
 * with its display size, or `{ error }`. Diagrams are drawn one after another and kept by content.
 */
export function drawDiagram(source, dark) {
  const drawn = queue.then(() => draw(source, dark)).catch((e) => ({ error: String(e?.message ?? e) }));
  queue = drawn;
  return drawn;
}
