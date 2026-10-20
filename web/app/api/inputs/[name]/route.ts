import { errorResponse } from "../../../../../src/workbench/http";
import { deleteInput } from "../../../../../src/workbench/inputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Covered by web/proxy.ts: the loopback and same-origin checks run before this handler.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    await deleteInput((await params).name);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error, "Deleting input");
  }
}
