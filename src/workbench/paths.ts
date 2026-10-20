import { resolve } from "node:path";

// The workbench is started from the repository root (see `bun run workbench`); the bundled route
// handlers cannot rely on their own module location, so the root comes from the process.
// These paths point at runtime data (configs, runs), not code: `turbopackIgnore` keeps Next's
// output tracing from treating the whole repository as server files.
export function repositoryRoot(): string {
  return resolve(
    /*turbopackIgnore: true*/ process.env.STATIGENT_ROOT ?? process.cwd(),
  );
}

export function workbenchRoot(): string {
  return resolve(
    /*turbopackIgnore: true*/ repositoryRoot(),
    "runs",
    "workbench",
  );
}

export function modelsConfigPath(): string {
  return resolve(
    /*turbopackIgnore: true*/ repositoryRoot(),
    "configs",
    "models.json",
  );
}
