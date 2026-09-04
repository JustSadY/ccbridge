import { SessionBridge as BaseSessionBridge } from "./bridge-base.js";
import { compatibilityReport } from "./compatibility.js";
import { resolveTargetCwdDetailed } from "./platform/cwd-map.js";
import { scanRegistry } from "./scan.js";

function mapped(result, options) {
  if (!result || typeof result !== "object") return result;
  const mapping = resolveTargetCwdDetailed(result.cwd ?? null, options);
  return { ...result, cwd: mapping.cwd, cwdMapping: mapping.mapped ? { method: mapping.method, mapping: mapping.mapping } : null };
}

export class SessionBridge extends BaseSessionBridge {
  async scan(options = {}) { return scanRegistry(this.registry, options); }
  async compatibility(options = {}) { return compatibilityReport(this.registry, options); }
  async fidelity(args) { return mapped(await super.fidelity(args), args); }
  async planArchiveImport(args) { return mapped(await super.planArchiveImport(args), args); }
  async planTransfer(args) { return mapped(await super.planTransfer(args), args); }
}
