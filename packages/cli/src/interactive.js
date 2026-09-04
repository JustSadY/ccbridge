import { createInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";

function line(output, value = "") { output.write(`${value}\n`); }
function targetCapable(adapter) { return Boolean(adapter?.capabilities?.write || adapter?.capabilities?.nativeImport); }
function short(value, length = 70) { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return text.length > length ? `${text.slice(0, length - 1)}…` : text; }

export function interactiveCandidates(scan, descriptors) {
  const source = (scan?.adapters ?? []).filter((item) => (item.sessionCount ?? 0) > 0 && item.discoverySupported !== false);
  const target = (descriptors ?? []).filter(targetCapable);
  return { source, target };
}

async function choose(rl, output, title, items, formatter) {
  if (!items.length) return null;
  line(output, `\n${title}`);
  items.forEach((item, index) => line(output, `  ${index + 1}) ${formatter(item, index)}`));
  while (true) {
    const answer = (await rl.question(`Select 1-${items.length} (q to cancel): `)).trim().toLowerCase();
    if (answer === "q" || answer === "quit" || answer === "cancel") return null;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < items.length) return items[index];
    line(output, "Invalid selection.");
  }
}

async function confirm(rl, output, prompt) {
  while (true) {
    const answer = (await rl.question(`${prompt} [y/N]: `)).trim().toLowerCase();
    if (!answer || answer === "n" || answer === "no") return false;
    if (answer === "y" || answer === "yes") return true;
    line(output, "Enter y or n.");
  }
}

function printPlan(output, plan) {
  line(output, "\nTransfer plan");
  line(output, `  route:        ${plan.route}`);
  line(output, `  from -> to:   ${plan.from} -> ${plan.to}`);
  line(output, `  mode:         ${plan.mode}`);
  line(output, `  preservation: ${plan.preservation ?? "unknown"}`);
  line(output, `  cwd:          ${plan.cwd ?? "<none>"}`);
  if (plan.format) line(output, `  native format:${plan.format}`);
  if (plan.messageCount !== undefined) line(output, `  messages:     ${plan.messageCount}`);
  if (plan.eventCount !== undefined) line(output, `  raw events:   ${plan.eventCount}`);
  if (plan.mode === "lossless") line(output, "  archive:      a lossless .ccbridge archive will also be written");
}

export async function runInteractive(bridge, options = {}) {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  if (options.requireTty !== false && (!input.isTTY || !output.isTTY)) throw new Error("Interactive mode requires a TTY; use normal ccbridge commands for scripts");
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  try {
    line(output, "ccbridge interactive transfer");
    const scan = await bridge.scan({ includeSessions: false });
    const descriptors = bridge.listAdapters();
    const candidates = interactiveCandidates(scan, descriptors);
    if (!candidates.source.length) throw new Error("No discoverable sessions were found. Run `ccbridge scan --sessions` for details.");

    const source = await choose(rl, output, "Source agent", candidates.source, (item) => `${item.name} (${item.id}) — ${item.sessionCount} session${item.sessionCount === 1 ? "" : "s"}`);
    if (!source) return { cancelled: true, stage: "source" };

    const sessions = await bridge.listSessions(source.id);
    if (!sessions.length) throw new Error(`${source.id} reported no sessions`);
    const visibleSessions = sessions.slice(0, Math.max(1, Number(options.sessionLimit ?? 50)));
    const session = await choose(rl, output, "Session", visibleSessions, (item) => `${short(item.title || item.id)}${item.updatedAt ? ` — ${item.updatedAt}` : ""}`);
    if (!session) return { cancelled: true, stage: "session", source: source.id };

    let targets = candidates.target.filter((item) => item.id !== source.id);
    while (targets.length) {
      const target = await choose(rl, output, "Target agent", targets, (item) => `${item.name} (${item.id})`);
      if (!target) return { cancelled: true, stage: "target", source: source.id, session: session.id };
      const mode = await choose(rl, output, "Transfer mode", ["lossless", "portable"], (item) => item === "lossless" ? "lossless — preserve raw/thinking data in .ccbridge too" : "portable — interoperable history only");
      if (!mode) return { cancelled: true, stage: "mode", source: source.id, session: session.id, target: target.id };

      let plan;
      try {
        plan = await bridge.planTransfer({ from: source.id, to: target.id, session: session.id, mode });
      } catch (error) {
        line(output, `\nNo compatible route to ${target.id}: ${error.message}`);
        targets = targets.filter((item) => item.id !== target.id);
        continue;
      }
      printPlan(output, plan);
      if (!await confirm(rl, output, "Execute this transfer?")) return { cancelled: true, stage: "confirm", plan };
      const result = await bridge.transfer({ from: source.id, to: target.id, session: session.id, mode });
      line(output, "\nTransfer completed.");
      return { cancelled: false, plan, result };
    }
    throw new Error("No compatible target route was selected");
  } finally {
    rl.close();
  }
}
