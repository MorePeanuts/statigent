import { runHandlers } from "../../../../../../../src/workbench/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await params;
  return runHandlers().file(id, path, request);
}
