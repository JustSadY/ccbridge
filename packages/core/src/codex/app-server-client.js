import { spawn } from "node:child_process";
import readline from "node:readline";

export class CodexAppServerClient {
  #process;
  #nextId = 1;
  #pending = new Map();
  #waiters = new Map();
  #stderr = [];

  constructor(options = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server", "--stdio"];
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
  }

  async start() {
    if (this.#process) return this;

    this.#process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    const output = readline.createInterface({ input: this.#process.stdout, crlfDelay: Infinity });
    output.on("line", (line) => this.#onLine(line));
    this.#process.stderr.on("data", (chunk) => this.#stderr.push(String(chunk)));
    this.#process.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})${this.stderr ? `: ${this.stderr}` : ""}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });

    await new Promise((resolve, reject) => {
      this.#process.once("spawn", resolve);
      this.#process.once("error", reject);
    });

    await this.request("initialize", {
      clientInfo: { name: "ccbridge", title: "ccbridge", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
    return this;
  }

  get stderr() {
    return this.#stderr.join("").trim();
  }

  request(method, params = null) {
    if (!this.#process) throw new Error("Codex app-server is not started");
    const id = this.#nextId++;
    const message = { id, method };
    if (params !== null) message.params = params;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write(message);
    });
  }

  notify(method, params = null) {
    const message = { method };
    if (params !== null) message.params = params;
    this.#write(message);
  }

  waitForNotification(method, { timeoutMs = 120000, predicate = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#removeWaiter(method, waiter);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      const waiter = {
        predicate,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        }
      };
      const list = this.#waiters.get(method) ?? [];
      list.push(waiter);
      this.#waiters.set(method, list);
    });
  }

  async close() {
    if (!this.#process) return;
    this.#process.stdin.end();
    this.#process.kill();
    this.#process = null;
  }

  #write(message) {
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message ?? "Codex app-server request failed");
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      const waiters = this.#waiters.get(message.method) ?? [];
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message.params)) {
          this.#removeWaiter(message.method, waiter);
          waiter.resolve(message.params);
        }
      }
    }
  }

  #removeWaiter(method, waiter) {
    const list = this.#waiters.get(method) ?? [];
    const next = list.filter((entry) => entry !== waiter);
    if (next.length) this.#waiters.set(method, next);
    else this.#waiters.delete(method);
  }
}
