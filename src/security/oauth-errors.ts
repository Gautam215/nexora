/**
 * Fixed messages for OAuth callback error codes. Pages render only
 * these messages, never a raw query value, and the provider's error
 * text is never shown or put in a URL.
 */
export const OAUTH_ERROR_MESSAGES = {
  oauth_failed: "Sign-in with Google did not complete. Try again or sign in with your password.",
  oauth_denied: "Google sign-in was not completed. Try again or sign in with your password.",
  oauth_expired: "The Google sign-in expired. Start again from the sign-in page.",
  oauth_already_linked: "This account already has a Google sign-in linked.",
  oauth_email_taken:
    "That email already has a Nexora account. Sign in with your password, then link Google from Account security.",
} as const;

export type OAuthErrorCode = keyof typeof OAUTH_ERROR_MESSAGES;

export function oauthErrorMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return OAUTH_ERROR_MESSAGES[value as OAuthErrorCode] ?? null;
}
