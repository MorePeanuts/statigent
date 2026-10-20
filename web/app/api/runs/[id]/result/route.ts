import { runHandlers } from "../../../../../../src/workbench/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return runHandlers().result((await params).id);
}
