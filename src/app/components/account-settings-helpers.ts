// Pure helpers for the account settings screen. Kept separate from the
// component so they can be tested with the project's node:test runner,
// which has no DOM or React testing library. The server remains the
// authority: these checks are a convenience, not a boundary.

export interface PasswordChangeValidation {
  valid: boolean;
  currentPasswordError: string;
  newPasswordError: string;
  confirmPasswordError: string;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function validatePasswordChange(
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
): PasswordChangeValidation {
  let currentPasswordError = "";
  let newPasswordError = "";
  let confirmPasswordError = "";

  if (codePointLength(currentPassword) < 1 || codePointLength(currentPassword) > 128) {
    currentPasswordError = "Enter your current password.";
  }
  if (codePointLength(newPassword) < 12 || codePointLength(newPassword) > 128) {
    newPasswordError = "Use a new password of 12 to 128 characters.";
  } else if (newPassword === currentPassword) {
    newPasswordError = "Use a new password that is different from the current one.";
  }
  if (confirmPassword !== newPassword) {
    confirmPasswordError = "The new passwords do not match.";
  }

  return {
    valid: !currentPasswordError && !newPasswordError && !confirmPasswordError,
    currentPasswordError,
    newPasswordError,
    confirmPasswordError,
  };
}

export function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

// Server error messages are curated and safe to show (they never
// contain database detail, tokens, or internal exceptions). Fall back
// to a plain-language message when the body is missing or malformed.
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const message = (body as ApiErrorBody).error?.message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export function passwordChangeSuccessMessage(otherSessionsRevoked: number): string {
  if (otherSessionsRevoked > 0) {
    return `Your password is updated. ${otherSessionsRevoked} other session${otherSessionsRevoked === 1 ? "" : "s"} signed out.`;
  }
  return "Your password is updated.";
}
