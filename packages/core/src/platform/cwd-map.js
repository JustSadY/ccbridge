import { windowsPathToWsl, wslPathToWindows } from "./paths.js";

export const TARGET_PROFILES = ["native", "windows", "wsl", "linux"];
function stripVerbatim(value) { return String(value ?? "").trim().replace(/^\\\\\?\\/, ""); }
function isWindowsPath(value) { return /^[A-Za-z]:[\\/]/.test(stripVerbatim(value)) || /^\\\\/.test(stripVerbatim(value)); }
function canonical(value) {
  let result = stripVerbatim(value).replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  if (/^[A-Za-z]:\//.test(result)) result = `${result[0].toLowerCase()}${result.slice(1)}`;
  if (result.length > 1) result = result.replace(/\/+$/, "");
  return result;
}
function joinMapped(target, suffix) {
  if (!suffix) return target;
  const windows = isWindowsPath(target);
  const separator = windows ? "\\" : "/";
  const base = String(target).replace(/[\\/]+$/, "");
  const rest = suffix.replace(/^\/+/, "").replaceAll("/", separator);
  return `${base}${separator}${rest}`;
}
export function parseCwdMapping(value) {
  const raw = String(value ?? "");
  const index = raw.indexOf("=");
  if (index <= 0 || index === raw.length - 1) throw new Error(`Invalid cwd mapping: ${value}. Expected FROM=TO`);
  const from = raw.slice(0, index).trim();
  const to = raw.slice(index + 1).trim();
  if (!from || !to) throw new Error(`Invalid cwd mapping: ${value}. Expected FROM=TO`);
  return { from, to };
}
export function normalizeCwdMappings(values = []) { return (values ?? []).map((value) => typeof value === "string" ? parseCwdMapping(value) : parseCwdMapping(`${value?.from ?? ""}=${value?.to ?? ""}`)); }
export function applyCwdMappings(cwd, values = []) {
  if (!cwd) return { cwd: cwd ?? null, mapped: false, method: null, mapping: null };
  const current = canonical(cwd);
  for (const mapping of normalizeCwdMappings(values)) {
    const source = canonical(mapping.from);
    const windowsSource = isWindowsPath(mapping.from);
    const left = windowsSource ? current.toLowerCase() : current;
    const right = windowsSource ? source.toLowerCase() : source;
    if (left !== right && !left.startsWith(`${right}/`)) continue;
    const suffix = current.slice(source.length);
    return { cwd: joinMapped(mapping.to, suffix), mapped: true, method: "explicit", mapping };
  }
  return { cwd: String(cwd), mapped: false, method: null, mapping: null };
}
export function resolveTargetCwdDetailed(cwd, options = {}) {
  const explicit = applyCwdMappings(cwd, options.cwdMappings ?? options.mappings ?? []);
  if (explicit.mapped || !explicit.cwd) return explicit;
  const profile = String(options.targetProfile ?? "native").toLowerCase();
  if (!TARGET_PROFILES.includes(profile)) throw new Error(`Unsupported target profile: ${options.targetProfile}. Expected one of: ${TARGET_PROFILES.join(", ")}`);
  if (profile === "wsl" && isWindowsPath(explicit.cwd)) return { cwd: windowsPathToWsl(explicit.cwd), mapped: true, method: "windows-to-wsl", mapping: null };
  if (profile === "windows" && /^\/mnt\/[A-Za-z]\//.test(explicit.cwd)) return { cwd: wslPathToWindows(explicit.cwd), mapped: true, method: "wsl-to-windows", mapping: null };
  return { cwd: explicit.cwd, mapped: false, method: profile === "native" ? null : "profile-noop", mapping: null };
}
export function resolveTargetCwd(cwd, options = {}) { return resolveTargetCwdDetailed(cwd, options).cwd; }
