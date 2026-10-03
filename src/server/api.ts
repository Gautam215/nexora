import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server.js";
import type { NextRequest } from "next/server";
import type { ZodType } from "zod";
import { OrganizationAccessDenied } from "./db.ts";
import { EmailConfigurationError } from "./email.ts";
import { RateLimitConfigurationError } from "../security/rate-limit.ts";

const MAX_JSON_BYTES = 16 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

export type ParsedBody<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

function requestId(request: NextRequest): string {
  const candidate = request.headers.get("x-request-id");
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function jsonResponse(
  request: NextRequest,
  payload: (id: string) => unknown,
  status: number,
  headers?: HeadersInit,
): NextResponse {
  const id = requestId(request);
  const responseHeaders = new Headers(headers);
  responseHeaders.set("x-request-id", id);
  responseHeaders.set("cache-control", "no-store");
  return NextResponse.json(payload(id), { status, headers: responseHeaders });
}

export function jsonOk(
  request: NextRequest,
  data: unknown,
  status = 200,
): NextResponse {
  return jsonResponse(request, (id) => ({ data, requestId: id }), status);
}

export function jsonError(
  request: NextRequest,
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): NextResponse {
  return jsonResponse(
    request,
    (id) => ({ error: { code, message }, requestId: id }),
    status,
    headers,
  );
}

export function logRouteFailure(
  request: NextRequest,
  operation: string,
  error: unknown,
): void {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const databaseCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_]{1,12}$/.test(error.code)
      ? error.code
      : undefined;
  console.error(
    JSON.stringify({
      event: "api.request_failed",
      operation,
      requestId: requestId(request),
      errorName,
      ...(databaseCode ? { errorCode: databaseCode } : {}),
    }),
  );
}

export function jsonServerFailure(
  request: NextRequest,
  operation: string,
  error: unknown,
): NextResponse {
  if (error instanceof OrganizationAccessDenied) {
    return jsonError(
      request,
      403,
      "ORGANIZATION_ACCESS_DENIED",
      "You do not have permission to manage this workspace.",
    );
  }
  if (
    error instanceof EmailConfigurationError ||
    error instanceof RateLimitConfigurationError
  ) {
    return jsonError(
      request,
      503,
      "SERVICE_UNAVAILABLE",
      "Authentication is not configured yet. Contact the workspace administrator.",
    );
  }
  logRouteFailure(request, operation, error);
  return jsonError(
    request,
    500,
    "INTERNAL_ERROR",
    "Unable to complete that request right now.",
  );
}

export function hasSameOrigin(request: NextRequest): boolean {
  const configuredOrigin = process.env.APP_ORIGIN;
  const requestOrigin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!configuredOrigin || !requestOrigin) return false;
  if (fetchSite && fetchSite !== "same-origin") return false;

  try {
    const expected = new URL(configuredOrigin);
    const actual = new URL(requestOrigin);
    if (expected.pathname !== "/" || expected.search || expected.hash) return false;
    if (process.env.NODE_ENV === "production" && expected.protocol !== "https:") {
      return false;
    }
    return actual.origin === expected.origin;
  } catch {
    return false;
  }
}

export async function parseJson<T>(
  request: NextRequest,
  schema: ZodType<T>,
): Promise<ParsedBody<T>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, status: 415, code: "UNSUPPORTED_MEDIA_TYPE", message: "Send JSON data." };
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    if (!/^\d+$/.test(declaredLength)) {
      return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Request body is invalid." };
    }
    if (Number(declaredLength) > MAX_JSON_BYTES) {
      return { ok: false, status: 413, code: "REQUEST_TOO_LARGE", message: "Request body is too large." };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Request body is missing." };
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_JSON_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413, code: "REQUEST_TOO_LARGE", message: "Request body is too large." };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Request body is invalid." };
  } finally {
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Request body is invalid." };
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, status: 400, code: "VALIDATION_FAILED", message: "Check the submitted fields." };
  }
  return { ok: true, value: parsed.data };
}
