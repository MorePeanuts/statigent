import { validateBackend } from "./backend";
import type { SessionConfig, SessionObserver } from "./protocol";
import { ScriptSession } from "./script-session";
import { DockerSession } from "./session";

export function createSession(
  config: SessionConfig,
  observer?: SessionObserver,
) {
  return validateBackend(config.backend) === "fresh-script"
    ? ScriptSession.create(config, observer)
    : DockerSession.create(config, observer);
}
