const SAFE_ORIGIN = "https://nexora.invalid";

export function safeReturnPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f]/.test(value)
  ) {
    return null;
  }

  try {
    const destination = new URL(value, SAFE_ORIGIN);
    if (destination.origin !== SAFE_ORIGIN) return null;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return null;
  }
}
