import { join } from "node:path";
import { imagesFromEnvironment } from "./agents";
import { inputRoot } from "./inputs";
import { modelsConfigPath, repositoryRoot, workbenchRoot } from "./paths";
import { createRunHandlers } from "./service";
import { installShutdownForwarding, Supervisor } from "./supervisor";

// One supervisor per server process. Next's development server re-evaluates route modules on
// every edit; the supervisor lives on globalThis so the handles of running workers survive that,
// while the handlers are rebuilt on each call so edited code takes effect.

const holder = globalThis as typeof globalThis & {
  __statigentSupervisor?: Supervisor;
};

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function bunExecutable(): string {
  // Under `bun --bun next` the server itself runs on Bun, so its executable runs the worker.
  return (
    process.env.WORKBENCH_BUN ??
    (process.versions.bun ? process.execPath : "bun")
  );
}

export function supervisor(): Supervisor {
  if (holder.__statigentSupervisor) return holder.__statigentSupervisor;
  const root = repositoryRoot();
  const created = new Supervisor({
    root: workbenchRoot(),
    cwd: root,
    modelsPath: modelsConfigPath(),
    // --no-env-file: Bun would otherwise load .env from the working directory into the worker,
    // bypassing the supervisor's environment allow-list. The key reaches it explicitly instead.
    workerCommand: [
      bunExecutable(),
      "--no-env-file",
      join(/*turbopackIgnore: true*/ root, "src", "workbench", "worker.ts"),
    ],
    maxRuns: positiveInteger("WORKBENCH_MAX_RUNS", 1),
    cancelGraceMs: 30_000,
    watchdogGraceMs: 60_000,
    environment: process.env,
  });
  installShutdownForwarding(created);
  holder.__statigentSupervisor = created;
  return created;
}

export function runHandlers() {
  return createRunHandlers({
    supervisor: supervisor(),
    inputRoot: inputRoot(),
    modelsPath: modelsConfigPath(),
    images: imagesFromEnvironment(),
    environment: process.env,
  });
}
