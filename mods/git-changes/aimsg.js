// "Generate commit message": one-shot call to a coding agent's CLI with the diff
// in the prompt (exec has no stdin). Pure helpers; panel.js owns the UI and exec.

export const AGENTS = {
  claude: { label: "Claude Code", command: "claude", models: ["", "haiku", "sonnet", "opus"], efforts: ["", "low", "medium", "high"] },
  codex: { label: "Codex", command: "codex", models: ["", "o4-mini", "gpt-5.4", "gpt-5.3-codex"], efforts: ["", "low", "medium", "high"] },
  hermes: { label: "Hermes", command: "hermes", models: ["", "claude-sonnet-4-5", "gpt-5.4", "gemini-2.5-pro"], efforts: ["", "low", "medium", "high"] },
  antigravity: { label: "Antigravity", command: "agy", models: ["", "gemini-2.5-pro", "gemini-2.5-flash"], efforts: [""] },
  cursor: { label: "Cursor", command: "agent", models: ["", "sonnet-4", "gpt-5"], efforts: [""] },
  gemini: { label: "Gemini", command: "gemini", models: ["", "gemini-2.5-flash", "gemini-2.5-pro"], efforts: [""] },
  opencode: { label: "OpenCode", command: "opencode", models: [""], efforts: [""] },
  pi: { label: "Pi", command: "pi", models: [""], efforts: [""] },
  copilot: { label: "Copilot", command: "copilot", models: [""], efforts: [""] },
};

export const TEMPLATES = {
  "": { label: "Default", hint: "Imperative subject (<=72 chars)" },
  conventional: { label: "Conventional Commits", hint: "type(scope): subject" },
  repo: { label: "Repo template / SKILL.md", hint: "commit.template, .gitmessage, or SKILL.md" },
};

export const TEMPLATE_PATHS = [
  ".gitmessage",
  ".github/commit-template.md",
  ".ai/skills/commit/SKILL.md",
  ".claude/skills/commit/SKILL.md",
];

export const DEFAULT_AI = { agent: "claude", model: "haiku", effort: "" };
export const MAX_DIFF = 12000; // chars; the prompt is an argument, so it must stay under the OS limit
const MAX_TEMPLATE = 3000;

export function normalizeAi(raw) {
  const agent = AGENTS[raw?.agent] ? raw.agent : DEFAULT_AI.agent;
  const a = AGENTS[agent];
  const model = a.models.includes(raw?.model) ? raw.model : agent === DEFAULT_AI.agent ? DEFAULT_AI.model : a.models[0];
  const effort = a.efforts.includes(raw?.effort) ? raw.effort : "";
  const template = TEMPLATES[raw?.template] ? raw.template : "";
  return template ? { agent, model, effort, template } : { agent, model, effort };
}

export const diffArgs = (mode, hasHead) => (mode === "staged" || !hasHead ? ["diff", "--cached", "--no-color", "-U2"] : ["diff", "HEAD", "--no-color", "-U2"]);

export function buildPrompt(diff, { recent = "", template = "", templateText = "" } = {}) {
  const cut = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]` : diff;
  const lines = [
    "Write a git commit message for the diff below.",
  ];
  if (template === "conventional") {
    lines.push("Use Conventional Commits format: <type>(<optional scope>): <short imperative summary> (types: feat, fix, refactor, docs, test, chore, ci, perf).");
    lines.push("Keep the subject line at most 72 characters with no trailing period.");
  } else {
    lines.push("Subject line: imperative mood, at most 72 characters, no trailing period.");
  }
  lines.push("Add a short body after a blank line only when the change needs it.");
  const custom = String(templateText ?? "").trim();
  if (custom) lines.push(`Follow these repository commit template / skill instructions:\n${custom.slice(0, MAX_TEMPLATE)}`);
  if (recent) lines.push(`Match the style of these recent subjects:\n${recent}`);
  lines.push("Reply with the commit message only: no quotes, no code fences, no commentary.", "", cut);
  return lines.join("\n");
}

// The CLI arguments for the chosen agent.
export function agentArgs({ agent, model, effort }, prompt) {
  if (agent === "hermes") return ["-z", prompt, ...(model ? ["-m", model] : []), ...(effort ? ["--reasoning", effort] : [])];
  if (agent === "codex") return ["exec", ...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []), prompt];
  if (agent === "gemini") return ["-p", prompt, ...(model ? ["-m", model] : [])];
  if (agent === "opencode") return ["run", ...(model ? ["-m", model] : []), prompt];
  if (agent === "antigravity" || agent === "cursor" || agent === "pi" || agent === "copilot") return ["-p", prompt, ...(model ? ["--model", model] : [])];
  return ["-p", prompt, "--no-session-persistence", ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
}

// Strips fences and wrapping quotes a model adds despite being told not to.
export function cleanMessage(out) {
  let text = String(out ?? "").trim().replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
  if (/^(["'`]).*\1$/s.test(text)) text = text.slice(1, -1).trim();
  return text;
}
