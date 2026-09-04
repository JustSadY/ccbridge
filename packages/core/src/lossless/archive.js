import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOSSLESS_BUNDLE_FORMAT = "ccbridge/lossless-session";
export const LOSSLESS_BUNDLE_VERSION = 1;

export function defaultCcbridgeHome({ env = process.env, home = os.homedir() } = {}) {
  return env.CCBRIDGE_HOME || path.join(home, ".ccbridge");
}

function safeName(value) {
  return String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

export async function writeLosslessBundle(session, options = {}) {
  if (!session?.lossless?.enabled) {
    throw new Error("Lossless bundle requires a session read in lossless mode");
  }

  const home = options.home ?? defaultCcbridgeHome(options);
  const destination = options.destination
    ? path.resolve(options.destination)
    : path.join(
        home,
        "lossless",
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(options.from ?? session.source?.adapter)}-to-${safeName(options.to)}-${safeName(session.id)}.ccbridge.json`
      );

  const bundle = {
    format: LOSSLESS_BUNDLE_FORMAT,
    version: LOSSLESS_BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    from: options.from ?? session.source?.adapter ?? null,
    to: options.to ?? null,
    session
  };

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);

  return {
    path: destination,
    format: LOSSLESS_BUNDLE_FORMAT,
    version: LOSSLESS_BUNDLE_VERSION,
    eventCount: session.events?.length ?? 0,
    messageCount: session.messages?.length ?? 0
  };
}
