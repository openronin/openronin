import { spawnSync } from "node:child_process";
import type { Db } from "../storage/db.js";
import { createDeploy, finishDeploy } from "../storage/deploys.js";

export type DeployMode = "local" | "ssh";

export type DeployOutcome = "success" | "build_failed" | "error";

export interface DeploySshTarget {
  user: string; // Linux user on the target server
  host: string; // hostname or IP, no 'user@' prefix
  port?: number;
  keyPath?: string;
  strictHostKeyChecking?: boolean;
}

export interface DeployInput {
  db: Db;
  repoId: number;
  sha: string;
  branch: string;
  triggeredBy: string;
  commands: string[];
  mode?: DeployMode; // default "local" (back-compat)
  ssh?: DeploySshTarget;
}

export interface DeployResult {
  outcome: DeployOutcome;
  deployId: number;
  error?: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runDeploy(input: DeployInput): Promise<DeployResult> {
  const { db, repoId, sha, branch, triggeredBy, commands } = input;
  const mode: DeployMode = input.mode ?? "local";
  const start = Date.now();

  const deployId = createDeploy(db, { repoId, sha, branch, triggeredBy });

  try {
    if (mode === "ssh") {
      if (!input.ssh?.host) {
        const error = "deploy.mode=ssh but ssh.host is missing";
        finishDeploy(db, deployId, { status: "error", error });
        return { outcome: "error", deployId, error, durationMs: Date.now() - start };
      }
    }

    for (const cmd of commands) {
      const { argv, label } = buildCommand(cmd, mode, input.ssh);
      const result = spawnSync(argv[0]!, argv.slice(1), {
        stdio: "pipe",
        timeout: DEFAULT_TIMEOUT_MS,
      });
      if (result.status !== 0 || result.error) {
        const stderr = (result.stderr?.toString() ?? "").trim();
        const stdout = (result.stdout?.toString() ?? "").trim();
        const detail =
          result.error?.message ?? `${label} exit ${result.status ?? "?"}: ${stderr || stdout}`;
        const error = detail.slice(0, 2000);
        finishDeploy(db, deployId, { status: "error", error });
        return { outcome: "build_failed", deployId, error, durationMs: Date.now() - start };
      }
    }

    finishDeploy(db, deployId, { status: "ok" });
    return { outcome: "success", deployId, durationMs: Date.now() - start };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    finishDeploy(db, deployId, { status: "error", error });
    return { outcome: "error", deployId, error, durationMs: Date.now() - start };
  }
}

// Translate a single shell command into a concrete argv depending on the
// deployment target.
//
//  local: bash -c "<cmd>" — runs on the openronin host itself.
//  ssh:   ssh [-i key] [-p port] [-o ...] user@host "<cmd>"
//         the cmd is passed as-is for the remote shell to interpret.
function buildCommand(
  cmd: string,
  mode: DeployMode,
  ssh: DeploySshTarget | undefined,
): { argv: string[]; label: string } {
  if (mode === "ssh" && ssh) {
    const args = ["-T", "-o", "BatchMode=yes"];
    if (ssh.strictHostKeyChecking === false) {
      args.push("-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null");
    }
    if (ssh.port && ssh.port !== 22) {
      args.push("-p", String(ssh.port));
    }
    if (ssh.keyPath) {
      args.push("-i", ssh.keyPath, "-o", "IdentitiesOnly=yes");
    }
    // Backwards compatibility: if `host` accidentally already contains
    // `user@`, don't double it up.
    const target = ssh.host.includes("@") ? ssh.host : `${ssh.user}@${ssh.host}`;
    args.push(target, cmd);
    return { argv: ["ssh", ...args], label: `ssh ${target}` };
  }
  return { argv: ["bash", "-c", cmd], label: "local" };
}
