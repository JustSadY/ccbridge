import fs from "node:fs/promises";
import path from "node:path";

export async function walkFiles(root, predicate = () => true) {
  const output = [];

  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EACCES") return;
      throw error;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile() && predicate(full, entry)) {
        output.push(full);
      }
    }
  }

  await visit(root);
  return output;
}

export async function pathExists(input) {
  try {
    await fs.access(input);
    return true;
  } catch {
    return false;
  }
}
