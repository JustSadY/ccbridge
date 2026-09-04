import fs from "node:fs";
import readline from "node:readline";

export async function* readJsonl(path, { ignoreMalformed = true } = {}) {
  const input = fs.createReadStream(path, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;

  for await (const raw of lines) {
    lineNumber += 1;
    const line = raw.trim();
    if (!line) continue;
    try {
      yield { value: JSON.parse(line), lineNumber };
    } catch (error) {
      if (!ignoreMalformed) {
        error.message = `${error.message} (${path}:${lineNumber})`;
        throw error;
      }
    }
  }
}
