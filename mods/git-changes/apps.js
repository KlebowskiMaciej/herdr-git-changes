import { exec, readTextFile, home } from "herdr";

const GIO_TIMEOUT = 10000;
const WINDOW_WAIT_MS = 10000;
const WINDOW_POLL_MS = 250;

/** The desktop IDs in `gio mime` output, each once, and the default one's (null when there is none). */
export function parseMimeApps(stdout) {
  const lines = stdout.split("\n");
  const defaultId = lines[0]?.match(/:\s*(\S+\.desktop)\s*$/)?.[1];
  const listed = lines.filter((l) => l.startsWith("\t")).map((l) => l.trim()).filter((id) => id.endsWith(".desktop"));
  return { defaultId: defaultId ?? null, ids: [...new Set([defaultId, ...listed].filter(Boolean))] };
}

/** The content type in `gio info -a standard::content-type` output, or null. */
export const parseContentType = (stdout) => stdout.match(/standard::content-type:\s*(\S+)/)?.[1] ?? null;

/** The unlocalized value of a key in a .desktop file's [Desktop Entry] group, or null. */
export function desktopEntryField(text, key) {
  let inEntry = false;
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line.startsWith("[")) inEntry = line === "[Desktop Entry]";
    else if (inEntry && line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim() || null;
  }
  return null;
}

/** The XDG folders that hold .desktop files, the user's own first. */
export function applicationDirs(env, homeDir) {
  const dataHome = env.XDG_DATA_HOME || `${homeDir}/.local/share`;
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return [dataHome, ...dataDirs].map((d) => `${d}/applications`);
}

async function gio(args) {
  const r = await exec("gio", args, { timeout: GIO_TIMEOUT });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gio ${args[0]} failed`);
  return r.stdout;
}

async function findDesktopFile(id, dirs) {
  for (const dir of dirs) {
    const text = await readTextFile(`${dir}/${id}`).catch(() => null);
    if (text !== null) return {
      path: `${dir}/${id}`,
      name: desktopEntryField(text, "Name") ?? id.replace(/\.desktop$/, ""),
      wmClass: desktopEntryField(text, "StartupWMClass"),
    };
  }
  return null;
}

/** The applications that open the file, as { path, name, wmClass, isDefault }; the default one first. */
export async function applicationsFor(file) {
  const type = parseContentType(await gio(["info", "-a", "standard::content-type", "--", file]));
  if (!type) return [];
  const { defaultId, ids } = parseMimeApps(await gio(["mime", type]));
  const dirs = applicationDirs(globalThis.process?.env ?? {}, home());
  const apps = await Promise.all(ids.map(async (id) => {
    const found = await findDesktopFile(id, dirs);
    return found && { ...found, isDefault: id === defaultId };
  }));
  return apps.filter(Boolean);
}

const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const luaQuote = (s) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;

/** The `hyprctl` arguments that start a shell command in a floating window: Hyprland's Lua form first, then its older one. */
export const floatingLaunches = (command) => [
  ["dispatch", `hl.dsp.exec_cmd(${luaQuote(command)}, { float = true })`],
  ["dispatch", "exec", `[float] ${command}`],
];

/** The `hyprctl` arguments that float a window: Hyprland's Lua form first, then its older one. */
export const floatingWindow = (address) => [
  ["dispatch", `hl.dsp.window.float({ action = "on", window = "address:${address}" })`],
  ["dispatch", "setfloating", `address:${address}`],
];

/** A window the application opened: of its StartupWMClass when the .desktop file names one. */
export const isAppWindow = (window, app) => !app.wmClass || window.class?.toLowerCase() === app.wmClass.toLowerCase();

async function dispatchFirst(variants) {
  for (const args of variants) {
    const r = await exec("hyprctl", args, { timeout: GIO_TIMEOUT }).catch(() => null);
    if (!r) return false;
    if (r.code === 0 && r.stdout.trim() === "ok") return true;
  }
  return false;
}

async function hyprlandWindows() {
  const r = await exec("hyprctl", ["-j", "clients"], { timeout: GIO_TIMEOUT }).catch(() => null);
  if (r?.code !== 0) return null;
  try {
    const windows = JSON.parse(r.stdout);
    return Array.isArray(windows) ? windows : null;
  } catch {
    return null;
  }
}

async function floatNewWindow(app, before, sleep) {
  const known = new Set(before.map((w) => w.address));
  for (let waited = 0; waited < WINDOW_WAIT_MS; waited += WINDOW_POLL_MS) {
    await sleep(WINDOW_POLL_MS);
    const opened = (await hyprlandWindows())?.find((w) => !known.has(w.address) && isAppWindow(w, app));
    if (opened) {
      if (!opened.floating) await dispatchFirst(floatingWindow(opened.address));
      return;
    }
  }
}

/**
 * Opens the file with the application. On Hyprland its window floats: by a rule on the launch,
 * and for an application that detaches from the launch, by floating its first new window within 10 seconds.
 * A file handed to a window that is already open leaves that window as it is.
 */
export async function launch(app, file, sleep) {
  const args = ["launch", app.path, file];
  const before = await hyprlandWindows();
  if (!before) return gio(args);
  if (!(await dispatchFirst(floatingLaunches(["gio", ...args].map(shellQuote).join(" "))))) await gio(args);
  await floatNewWindow(app, before, sleep);
}
