import { readFile } from "node:fs/promises";
import { selectProfile } from "../../../../src/models/config";
import { readManifest } from "../../../../src/records/store";
import { modelsConfigPath } from "../../../../src/workbench/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proves the route bundle can load repository modules (including ones that use Bun APIs at call
// time) and reports which runtime serves it. Profile contents are validated but never returned.
export async function GET() {
  const models: unknown = JSON.parse(
    await readFile(modelsConfigPath(), "utf8"),
  );
  const ids = Array.isArray(models)
    ? models.map((entry) => selectProfile(models, String(entry?.id)).id)
    : [];
  return Response.json({
    status: "ok",
    runtime: typeof Bun === "undefined" ? "node" : `bun ${Bun.version}`,
    model_profiles: ids.length,
    record_reader: typeof readManifest === "function",
  });
}
