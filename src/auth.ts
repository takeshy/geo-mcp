import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

function sameSecret(presented: string, expected: string): boolean {
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/** The gateway validates this Google API key before invoking the private service. */
export function authorizeRequest(headers: IncomingHttpHeaders, apiKey: string | undefined, gatewayKey: string | undefined): boolean {
  if (gatewayKey && headers["x-api-key"] !== undefined) {
    const presented = headers["x-api-key"];
    return typeof presented === "string" && sameSecret(presented, gatewayKey);
  }
  // Retain the existing Bearer interface for local use and the migration window.
  // In production, Cloud Run IAM prevents direct client access to this service.
  return authorize(headers.authorization, apiKey);
}

/**
 * Bearer-token check for the MCP endpoint.
 *
 * The key is one shared secret set by the operator (MCP_API_KEY). Every client
 * that may call the tools - a kakeratta deployment, an Agent Plugin - sends it
 * as `Authorization: Bearer <key>`. With no key configured the endpoint stays
 * open, which is what local development wants; the server logs that state.
 */
export function authorize(authorization: string | undefined, apiKey: string | undefined): boolean {
  const expected = (apiKey ?? "").trim();
  if (expected === "") return true;
  const match = /^Bearer\s+(.+)$/i.exec((authorization ?? "").trim());
  if (!match) return false;
  return sameSecret(match[1]!.trim(), expected);
}
