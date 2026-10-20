import { listModelOptions } from "../../../../src/workbench/models";
import { modelsConfigPath } from "../../../../src/workbench/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({
      models: await listModelOptions(modelsConfigPath()),
    });
  } catch (error) {
    // Validation messages name fields, not values; the config holds no secrets, only key variable names.
    return Response.json(
      {
        error: `Invalid model configuration: ${error instanceof Error ? error.message : "unknown error"}`,
      },
      { status: 500 },
    );
  }
}
