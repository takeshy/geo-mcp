import assert from "node:assert/strict";
import test from "node:test";
import { authorize, authorizeRequest } from "../src/auth.js";

test("no configured key leaves the endpoint open", () => {
  assert.equal(authorize(undefined, undefined), true);
  assert.equal(authorize("Bearer anything", "  "), true);
});

test("gateway requests require the dedicated key and ignore forwarded credentials", () => {
  assert.equal(authorizeRequest({ "x-api-key": "gateway-secret", authorization: "Bearer gateway-id-token" }, "legacy-secret", "gateway-secret"), true);
  assert.equal(authorizeRequest({ "x-api-key": "wrong-key", authorization: "Bearer legacy-secret" }, "legacy-secret", "gateway-secret"), false);
  assert.equal(authorizeRequest({ "x-api-key": ["gateway-secret", "wrong-key"] }, "legacy-secret", "gateway-secret"), false);
  assert.equal(authorizeRequest({ "x-forwarded-authorization": "Bearer legacy-secret", authorization: "Bearer gateway-id-token" }, "legacy-secret", "gateway-secret"), false);
  assert.equal(authorizeRequest({ authorization: "Bearer legacy-secret" }, "legacy-secret", "gateway-secret"), true);
  assert.equal(authorizeRequest({ "x-api-key": "gateway-secret" }, "legacy-secret", undefined), false);
});

test("a configured key requires the matching bearer token", () => {
  assert.equal(authorize("Bearer secret-1", "secret-1"), true);
  assert.equal(authorize("bearer secret-1", "secret-1"), true);
  assert.equal(authorize("Bearer secret-2", "secret-1"), false);
  assert.equal(authorize("Bearer secret-10", "secret-1"), false);
  assert.equal(authorize("Basic c2VjcmV0LTE=", "secret-1"), false);
  assert.equal(authorize(undefined, "secret-1"), false);
  assert.equal(authorize("", "secret-1"), false);
});
