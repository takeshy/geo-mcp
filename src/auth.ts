import { timingSafeEqual } from "node:crypto";

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
  const presented = Buffer.from(match[1]!.trim());
  const wanted = Buffer.from(expected);
  return presented.length === wanted.length && timingSafeEqual(presented, wanted);
}
