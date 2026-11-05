import { test } from "node:test";
import assert from "node:assert/strict";
import { userError, SAFE_JOB_ERROR } from "../../backend/app/errors.js";

const STATIC_LINE = "This subject barely moves, so there is no sequence to show. Try Basic or Advanced.";

test("static-subject line passes the safe-job filter untouched", () => {
  assert.ok(SAFE_JOB_ERROR.test(STATIC_LINE), "allowlisted");
  assert.equal(userError(new Error(STATIC_LINE), "The lite build failed.", SAFE_JOB_ERROR), STATIC_LINE);
});

test("unknown failures still fall back to generic text", () => {
  assert.equal(
    userError(new Error("/tmp/x/plate.png: ffmpeg boom"), "The lite build failed.", SAFE_JOB_ERROR),
    "The lite build failed."
  );
});
