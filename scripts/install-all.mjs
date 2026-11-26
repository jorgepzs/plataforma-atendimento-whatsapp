import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function installPlan(directory) {
  return {
    command: "npm",
    args: ["ci"],
    cwd: resolve(root, directory)
  };
}

function runDirect() {
  const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
  return invoked === fileURLToPath(import.meta.url);
}

if (runDirect()) {
  for (const directory of ["apps/api", "apps/web"]) {
    const plan = installPlan(directory);
    const result = spawnSync(plan.command, plan.args, {
      cwd: plan.cwd,
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
