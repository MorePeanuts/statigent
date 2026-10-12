import type { AgentStatus } from "./run";
export class Stop extends Error {
  constructor(
    readonly status: AgentStatus,
    readonly reason: string,
  ) {
    super(reason);
  }
}
