import "server-only";
import nodemailer, { type Transporter } from "nodemailer";

let transporter: Transporter | undefined;

export class EmailConfigurationError extends Error {
  constructor() {
    super("Authentication email delivery is not configured");
    this.name = "EmailConfigurationError";
  }
}

// Delivery failed after configuration was validated: the SMTP server
// could not be reached, rejected the connection or authentication, or
// timed out. The message deliberately carries no SMTP detail, because
// the caller must never return that detail to a client.
export class EmailDeliveryError extends Error {
  constructor() {
    super("Authentication email delivery failed");
    this.name = "EmailDeliveryError";
  }
}

function getAppOrigin(): URL {
  const value = process.env.APP_ORIGIN;
  if (!value) throw new EmailConfigurationError();
  const origin = new URL(value);
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new EmailConfigurationError();
  }
  if (process.env.NODE_ENV === "production" && origin.protocol !== "https:") {
    throw new EmailConfigurationError();
  }
  return origin;
}

function getTransporter(): Transporter {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST?.trim();
  const from = process.env.SMTP_FROM?.trim();
  const port = Number(process.env.SMTP_PORT ?? "587");
  const username = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;
  const secure = process.env.SMTP_SECURE === "true";
  const requireTLS = process.env.SMTP_REQUIRE_TLS !== "false";
  if (
    !host ||
    !from ||
    /[\r\n]/.test(from) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (port === 465 && !secure) ||
    Boolean(username) !== Boolean(password)
  ) {
    throw new EmailConfigurationError();
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure && requireTLS,
    auth: username ? { user: username, pass: password } : undefined,
    tls: { minVersion: "TLSv1.2" },
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return transporter;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[character];
  });
}

async function sendLink(
  to: string,
  path: string,
  token: string,
  subject: string,
  action: string,
  expiry: string,
): Promise<void> {
  const url = getAppOrigin();
  url.pathname = path;
  url.search = "";
  url.searchParams.set("token", token);
  const link = url.toString();
  const safeAction = escapeHtml(action);
  try {
    await getTransporter().sendMail({
    from: process.env.SMTP_FROM?.trim(),
    to,
    subject,
    text: `${action}: ${link}\n\nThis link expires ${expiry}. If you did not request this, ignore this message.`,
    html: `<p>${safeAction}:</p><p><a href="${escapeHtml(link)}">Continue</a></p><p>This link expires ${expiry}. If you did not request this, ignore this message.</p>`,
    });
  } catch (error) {
    // Configuration errors must stay configuration errors: the route
    // maps them to "not configured", not to "delivery unavailable".
    // Only a genuine send failure is replaced, because the original
    // error may name a host, a port, or an SMTP reply, and none of that
    // belongs in a client response; the route handler logs the failure
    // under its own operation name.
    if (error instanceof EmailConfigurationError) throw error;
    throw new EmailDeliveryError();
  }
}

export function validateEmailDeliveryConfig(): void {
  getAppOrigin();
  getTransporter();
}

// Actually contact the SMTP server before any account work is done.
// Configuration validation alone only checks that variables are present
// and well-formed; nodemailer creates its transporter lazily, so a dead,
// refusing, or mis-authenticated server would otherwise only surface
// when a message is sent — after a user, token, or reset has already
// been created. Verifying first has two further effects: during an SMTP
// outage every request to these endpoints fails the same way, before
// any eligibility check, so the failure response cannot distinguish an
// eligible address from an ineligible one; and a failed registration
// creates no account that can never be verified. A send that fails
// after a successful verify (a transient drop between the two) is still
// reported as a delivery failure by the route, not as success.
export async function verifyEmailDelivery(): Promise<void> {
  try {
    await getTransporter().verify();
  } catch (error) {
    if (error instanceof EmailConfigurationError) throw error;
    throw new EmailDeliveryError();
  }
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  await sendLink(
    to,
    "/verify-email",
    token,
    "Confirm your Nexora email",
    "Confirm the email address for your Nexora account",
    "in two hours",
  );
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  await sendLink(
    to,
    "/reset-password",
    token,
    "Reset your Nexora password",
    "Reset the password for your Nexora account",
    "in one hour",
  );
}

// Generic notification email, used only by the notification-email
// worker (never synchronously from a mutation route). The subject
// and body come from the in-app notification, which is already
// bounded (title 1–120, body 1–500) and never contains a secret.
// Configuration errors stay configuration errors; a genuine send
// failure becomes EmailDeliveryError with no SMTP detail.
export async function sendNotificationEmail(
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const safeSubject = subject.replace(/[\r\n]+/g, " ").slice(0, 120);
  const safeText = text.slice(0, 500);
  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM?.trim(),
      to,
      subject: safeSubject,
      text: safeText,
      html: `<p>${escapeHtml(safeText)}</p>`,
    });
  } catch (error) {
    if (error instanceof EmailConfigurationError) throw error;
    throw new EmailDeliveryError();
  }
}

export async function sendOrganizationInvitationEmail(
  to: string,
  token: string,
  organizationName: string,
): Promise<void> {
  const safeName = organizationName.replace(/[\r\n\t]+/g, " ").slice(0, 120);
  await sendLink(
    to,
    "/accept-invitation",
    token,
    "You are invited to Nexora",
    `You are invited to join ${safeName} on Nexora`,
    "in seven days",
  );
}
