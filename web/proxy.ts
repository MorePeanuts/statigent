import { NextResponse } from "next/server";
import { checkLocalAccess } from "../src/workbench/access";

export function proxy(request: Request) {
  const decision = checkLocalAccess({
    method: request.method,
    host: request.headers.get("host"),
    origin: request.headers.get("origin"),
  });
  if (decision.allowed) return NextResponse.next();
  return NextResponse.json(
    { error: decision.reason },
    { status: decision.status },
  );
}

export const config = {
  // Proxy buffers request bodies in memory up to a size limit and truncates beyond it, so the
  // upload endpoint (exactly /api/inputs) is left out and applies the same check itself.
  matcher: ["/((?!api/inputs$).*)"],
};
