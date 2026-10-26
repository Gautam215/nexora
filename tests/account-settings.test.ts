import assert from "node:assert/strict";
import test from "node:test";
import {
  apiErrorMessage,
  formatSessionTime,
  passwordChangeSuccessMessage,
  validatePasswordChange,
} from "../src/app/components/account-settings-helpers.ts";

test("password change validation enforces the server policy and the confirmation match", () => {
  const ok = validatePasswordChange("old password here", "new password here", "new password here");
  assert.equal(ok.valid, true);
  assert.equal(ok.newPasswordError, "");

  const short = validatePasswordChange("old password here", "short", "short");
  assert.equal(short.valid, false);
  assert.match(short.newPasswordError, /12 to 128/);

  const mismatch = validatePasswordChange("old password here", "new password here", "different one");
  assert.equal(mismatch.valid, false);
  assert.match(mismatch.confirmPasswordError, /do not match/);

  const same = validatePasswordChange("same password here", "same password here", "same password here");
  assert.equal(same.valid, false);
  assert.match(same.newPasswordError, /different/);

  // Code points, not UTF-16 units: 12 lock characters are a valid password.
  const emoji = validatePasswordChange("old password here", "🔒".repeat(12), "🔒".repeat(12));
  assert.equal(emoji.valid, true);
});

test("api error messages use the server message and never invent one from a malformed body", () => {
  assert.equal(
    apiErrorMessage({ error: { code: "INVALID_CREDENTIALS", message: "Current password is incorrect." } }, "Fallback"),
    "Current password is incorrect.",
  );
  assert.equal(apiErrorMessage(null, "Fallback"), "Fallback");
  assert.equal(apiErrorMessage({ error: { code: "X" } }, "Fallback"), "Fallback");
  assert.equal(apiErrorMessage({ error: { message: "" } }, "Fallback"), "Fallback");
});

test("password change success message reports the revoked session count only when it is positive", () => {
  assert.equal(passwordChangeSuccessMessage(0), "Your password is updated.");
  assert.equal(
    passwordChangeSuccessMessage(1),
    "Your password is updated. 1 other session signed out.",
  );
  assert.equal(
    passwordChangeSuccessMessage(3),
    "Your password is updated. 3 other sessions signed out.",
  );
});

test("session times format as a readable date and pass through an unparseable value unchanged", () => {
  const formatted = formatSessionTime("2026-10-25T11:30:00.000Z");
  assert.match(formatted, /2026/);
  assert.equal(formatSessionTime("not-a-date"), "not-a-date");
});
