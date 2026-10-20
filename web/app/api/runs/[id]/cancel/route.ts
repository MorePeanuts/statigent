import { runHandlers } from "../../../../../../src/workbench/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return runHandlers().cancel((await params).id);
}
