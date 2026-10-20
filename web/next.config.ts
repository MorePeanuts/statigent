import { resolve } from "node:path";
import type { NextConfig } from "next";

// The app lives in web/ but its route handlers import modules from the repository's src/;
// both the bundler and output tracing must treat the repository root as the project root.
const repositoryRoot = resolve(import.meta.dirname, "..");

const config: NextConfig = {
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
  // A local single-user tool: no telemetry banner, no image optimizer fetching remote hosts.
  images: { unoptimized: true },
  poweredByHeader: false,
  // Engineering conventions live in the repository's own AGENTS.md; keep `next dev` from adding another.
  agentRules: false,
};

export default config;
