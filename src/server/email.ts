import "server-only";
import nodemailer, { type Transporter } from "nodemailer";

let transporter: Transporter | undefined;

export class EmailConfigurationError extends Error {
  constructor() {
    super("Authentication email delivery is not configured");
    this.name = "EmailConfigurationError";
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
  await getTransporter().sendMail({
    from: process.env.SMTP_FROM?.trim(),
    to,
    subject,
    text: `${action}: ${link}\n\nThis link expires ${expiry}. If you did not request this, ignore this message.`,
    html: `<p>${safeAction}:</p><p><a href="${escapeHtml(link)}">Continue</a></p><p>This link expires ${expiry}. If you did not request this, ignore this message.</p>`,
  });
}

export function validateEmailDeliveryConfig(): void {
  getAppOrigin();
  getTransporter();
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
