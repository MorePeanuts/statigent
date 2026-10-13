import { obj, str } from "../../models/validation";
import { id } from "../contracts";
import { command } from "../process";
export async function inspectImage(
  image: string,
): Promise<Record<string, unknown>> {
  const info = obj(
    JSON.parse(
      (await command(["docker", "info", "--format", "{{json .}}"])).stdout,
    ),
  );
  if (
    ![
      "MemoryLimit",
      "SwapLimit",
      "PidsLimit",
      "CpuCfsQuota",
      "CpuCfsPeriod",
    ].every((k) => info[k] === true)
  )
    throw new Error("Docker cannot enforce resource limits");
  const values: unknown = JSON.parse(
    (await command(["docker", "image", "inspect", image])).stdout,
  );
  if (!Array.isArray(values) || values.length !== 1)
    throw new Error("Invalid image metadata");
  const x = obj(values[0]);
  if (x.Os !== "linux") throw new Error("Linux image required");
  return {
    image_id: str(x.Id, "image ID"),
    runtime_labels: obj(x.Config).Labels ?? {},
    platform: `${str(x.Os, "OS")}/${str(x.Architecture, "arch")}`,
    digests: x.RepoDigests,
    docker: info.ServerVersion,
  };
}
export async function cleanupContainers(
  evaluationId: string,
  unitId?: string,
): Promise<void> {
  const filters = [
    "--filter",
    `label=org.statigent.evaluation=${id(evaluationId)}`,
  ];
  if (unitId)
    filters.push("--filter", `label=org.statigent.unit=${id(unitId)}`);
  const found = (
    await command(["docker", "ps", "-aq", ...filters])
  ).stdout.trim();
  if (!found) return;
  const containers = found.split(/\s+/);
  if (containers.some((x) => !/^[a-f0-9]{12,64}$/.test(x)))
    throw new Error("Invalid container identities");
  await command(["docker", "rm", "-f", ...containers]);
  if ((await command(["docker", "ps", "-aq", ...filters])).stdout.trim())
    throw new Error("Container cleanup incomplete");
}
