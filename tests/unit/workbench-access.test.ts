import { expect, test } from "bun:test";
import { checkLocalAccess, rejectNonLocal } from "../../src/workbench/access";

const allowed = { allowed: true } as const;

test("loopback hosts are accepted for reads, with or without a port", () => {
  for (const host of [
    "127.0.0.1:3100",
    "localhost:3100",
    "[::1]:3100",
    "LOCALHOST",
    "127.0.0.1",
  ])
    expect(checkLocalAccess({ method: "GET", host, origin: null })).toEqual(
      allowed,
    );
});

test("foreign, missing and look-alike hosts are rejected before any work", () => {
  for (const host of [
    "evil.example:3100",
    "127.0.0.1.evil.example",
    "localhost.evil.example:3100",
    "192.168.1.5:3100",
    "[::2]:3100",
    "",
    null,
  ])
    expect(
      checkLocalAccess({ method: "GET", host, origin: null }).allowed,
    ).toBe(false);
});

test("state-changing requests require the workbench's own origin", () => {
  const host = "127.0.0.1:3100";
  expect(
    checkLocalAccess({ method: "POST", host, origin: "http://127.0.0.1:3100" }),
  ).toEqual(allowed);
  for (const origin of [
    "https://evil.example",
    "http://localhost:3100",
    "http://127.0.0.1:3101",
    "https://127.0.0.1:3100",
    "null",
    "not a url",
    null,
  ])
    expect(checkLocalAccess({ method: "DELETE", host, origin }).allowed).toBe(
      false,
    );
});

test("route handlers outside the proxy get the same decision as a 403 response", async () => {
  const ok = new Request("http://127.0.0.1:3100/api/inputs", {
    method: "POST",
    headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
  });
  expect(rejectNonLocal(ok)).toBeNull();
  const crossSite = new Request("http://127.0.0.1:3100/api/inputs", {
    method: "POST",
    headers: { host: "127.0.0.1:3100", origin: "https://evil.example" },
  });
  const response = rejectNonLocal(crossSite);
  expect(response?.status).toBe(403);
  expect(await response?.json()).toEqual({
    error: "Cross-origin state-changing request",
  });
});
