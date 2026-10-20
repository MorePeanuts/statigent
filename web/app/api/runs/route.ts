import { runHandlers } from "../../../../src/workbench/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return runHandlers().list();
}

export function POST(request: Request) {
  return runHandlers().submit(request);
}
