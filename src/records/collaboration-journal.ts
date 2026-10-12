import { str } from "../models/validation";
import type { AgentRole } from "./agent-metadata";

/** Checks host routing identities; this deliberately does not judge analysis semantics. */
export class CollaborationJournal {
  active: string | null = null;
  private delegated = new Set<string>();
  private requests = new Map<
    string,
    { role: AgentRole; subtask_id: string | null; terminal: boolean }
  >();
  accept(type: string, event: Record<string, unknown>): void {
    const role = event.role;
    if (role !== "planner" && role !== "executor")
      throw new Error("Invalid event role");
    const subtask = event.subtask_id;
    if (subtask !== null && typeof subtask !== "string")
      throw new Error("Invalid event subtask");
    if (type === "subtask_delegated") {
      const id = str(subtask, "subtask_id");
      if (role !== "planner" || this.active || this.delegated.has(id))
        throw new Error("Invalid or duplicate delegation");
      str(event.tool_id, "tool_id");
      this.delegated.add(id);
      this.active = id;
      return;
    }
    if (
      role === "executor"
        ? !this.active || subtask !== this.active
        : subtask !== null || this.active !== null
    )
      throw new Error("Role/subtask routing mismatch");
    if (type === "subtask_returned") {
      if (role !== "executor")
        throw new Error("Only executor returns a subtask");
      this.active = null;
    }
    if (type === "model_request") {
      const id = str(event.attempt_id, "attempt_id");
      if (this.requests.has(id)) throw new Error("Duplicate model attempt");
      this.requests.set(id, { role, subtask_id: subtask, terminal: false });
    }
    if (type === "model_response" || type === "model_failure") {
      const request = this.requests.get(str(event.attempt_id, "attempt_id"));
      if (
        !request ||
        request.terminal ||
        request.role !== role ||
        request.subtask_id !== subtask
      )
        throw new Error("Model attempt identity mismatch");
      request.terminal = true;
    }
  }
  unresolved() {
    return [...this.requests]
      .filter(([, r]) => !r.terminal)
      .map(([attempt_id, r]) => ({
        attempt_id,
        role: r.role,
        subtask_id: r.subtask_id,
      }));
  }
}
