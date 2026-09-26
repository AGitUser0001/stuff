import assert from "node:assert/strict";
import test from "node:test";
import { httpStatus, isTransientNetworkError } from "./network_errors.mjs";

test("youtubei.js HTTP errors expose their status without losing retryability", () => {
  const error = new Error("Request to https://youtube.com/youtubei/v1/live_chat/get_live_chat failed with status code 503");
  assert.equal(httpStatus(error), 503);
  assert.equal(isTransientNetworkError(error), true);
  assert.equal(isTransientNetworkError(new Error("Request to URL failed with status code 403")), false);
  assert.equal(httpStatus({ response: { status: 429 } }), 429);
});

test("fetch failures have no invented status; programming errors stay unexpected", () => {
  const error = new TypeError("fetch failed");
  assert.equal(httpStatus(error), undefined);
  assert.equal(isTransientNetworkError(error), true);
  assert.equal(isTransientNetworkError(new TypeError("cannot read properties of undefined")), false);
});
