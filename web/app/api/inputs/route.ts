import { rejectNonLocal } from "../../../../src/workbench/access";
import { errorResponse, streamChunks } from "../../../../src/workbench/http";
import {
  InputError,
  listInputs,
  maxUploadBytes,
  saveInput,
} from "../../../../src/workbench/inputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This exact path is excluded from web/proxy.ts (the proxy would buffer and truncate large
// bodies), so both handlers apply the loopback check themselves.

export async function GET(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    return Response.json({ inputs: await listInputs() });
  } catch (error) {
    return errorResponse(error, "Listing inputs");
  }
}

/** Raw-body upload: `POST /api/inputs?name=<file name>` with the file bytes as the body. */
export async function POST(request: Request) {
  const rejected = rejectNonLocal(request);
  if (rejected) return rejected;
  try {
    const name = new URL(request.url).searchParams.get("name");
    if (!name) throw new InputError("Query parameter 'name' is required", 400);
    const declared = request.headers.get("content-length");
    const saved = await saveInput(name, streamChunks(request.body), {
      maxBytes: maxUploadBytes(),
      expectedBytes: declared === null ? undefined : Number(declared),
    });
    return Response.json({ input: saved }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "Uploading input");
  }
}
