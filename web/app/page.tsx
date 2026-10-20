import { DEFAULT_BUDGET } from "../../src/agent/config";
import { Workbench } from "../components/Workbench";

export const dynamic = "force-dynamic";

export default function HomePage() {
  // Rendered on the server so the form shows the agent's real defaults, not a copy of them.
  return (
    <Workbench
      defaults={{
        model_attempts: DEFAULT_BUDGET.model_attempts,
        executions: DEFAULT_BUDGET.executions,
        total_tokens: DEFAULT_BUDGET.total_tokens,
        task_timeout_ms: DEFAULT_BUDGET.task_timeout_ms,
      }}
    />
  );
}
