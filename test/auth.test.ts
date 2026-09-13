import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "../src/auth.js";

test("no configured key leaves the endpoint open", () => {
  assert.equal(authorize(undefined, undefined), true);
  assert.equal(authorize("Bearer anything", "  "), true);
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
