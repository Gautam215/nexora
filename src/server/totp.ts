import "server-only";
import type { DatabaseTransaction } from "./db.ts";
import {
  decryptTotpSecret,
  TotpConfigurationError,
  verifyTotpCode,
} from "../security/totp.ts";

// Authenticator credential rows, read inside the caller's user or
// organization context (the table's RLS policies admit only the
// row's own user). A verified row gates deletion; a pending row
// (verified_at NULL) does not, so an abandoned setup can never
// lock the owner out. Decryption or key problems fail closed:
// verifyTotpForDelete throws TotpConfigurationError, which the
// delete routes map to 503, never to a skipped second factor.

export type TotpDeleteCheck =
  | "not-enrolled"
  | "missing-code"
  | "invalid"
  | "valid";

type TotpRow = {
  secret_ciphertext: string;
  secret_nonce: string;
  secret_tag: string;
  verified_at: string | null;
};

async function readTotpRow(
  transaction: DatabaseTransaction,
  userId: string,
): Promise<TotpRow | null> {
  const result = await transaction.query<TotpRow>(
    `SELECT secret_ciphertext, secret_nonce, secret_tag, verified_at::text AS verified_at
     FROM nexora.user_totp_credentials WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function getTotpEnrolled(
  transaction: DatabaseTransaction,
  userId: string,
): Promise<boolean> {
  const row = await readTotpRow(transaction, userId);
  return row !== null && row.verified_at !== null;
}

export async function createTotpSetup(
  transaction: DatabaseTransaction,
  userId: string,
  encrypted: { ciphertext: string; nonce: string; tag: string },
): Promise<void> {
  // The INSERT writes only the four columns the app role holds
  // INSERT privilege for; verified_at defaults to NULL (pending)
  // and updated_at defaults to now(). Writing verified_at or
  // updated_at explicitly here would fail with 42501.
  await transaction.query(
    `INSERT INTO nexora.user_totp_credentials
       (user_id, secret_ciphertext, secret_nonce, secret_tag)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       secret_ciphertext = EXCLUDED.secret_ciphertext,
       secret_nonce = EXCLUDED.secret_nonce,
       secret_tag = EXCLUDED.secret_tag,
       verified_at = NULL,
       updated_at = pg_catalog.now()`,
    [userId, encrypted.ciphertext, encrypted.nonce, encrypted.tag],
  );
}

export async function verifyTotpSetup(
  transaction: DatabaseTransaction,
  userId: string,
  code: string,
  timeMs: number,
): Promise<"not-pending" | "invalid" | "valid"> {
  const row = await readTotpRow(transaction, userId);
  if (row === null || row.verified_at !== null) return "not-pending";
  const secret = decryptTotpSecret(row.secret_ciphertext, row.secret_nonce, row.secret_tag);
  if (!verifyTotpCode(secret, code, timeMs)) return "invalid";
  await transaction.query(
    `UPDATE nexora.user_totp_credentials
     SET verified_at = pg_catalog.now(), updated_at = pg_catalog.now()
     WHERE user_id = $1 AND verified_at IS NULL`,
    [userId],
  );
  return "valid";
}

export async function deleteTotpCredential(
  transaction: DatabaseTransaction,
  userId: string,
): Promise<void> {
  await transaction.query(
    `DELETE FROM nexora.user_totp_credentials WHERE user_id = $1`,
    [userId],
  );
}

export async function verifyTotpForDelete(
  transaction: DatabaseTransaction,
  userId: string,
  code: string | undefined,
  timeMs: number,
): Promise<TotpDeleteCheck> {
  const row = await readTotpRow(transaction, userId);
  if (row === null || row.verified_at === null) return "not-enrolled";
  if (code === undefined) return "missing-code";
  const secret = decryptTotpSecret(row.secret_ciphertext, row.secret_nonce, row.secret_tag);
  return verifyTotpCode(secret, code, timeMs) ? "valid" : "invalid";
}

export { TotpConfigurationError };
