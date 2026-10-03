import "server-only";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;
const DUMMY_SALT = Buffer.alloc(SALT_LENGTH);

export class PasswordPolicyError extends Error {
  constructor() {
    super("Password must contain 12 to 128 characters");
    this.name = "PasswordPolicyError";
  }
}

function passwordLengthIsValid(password: string): boolean {
  const characters = Array.from(password).length;
  return characters >= 12 && characters <= 128;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!passwordLengthIsValid(password)) throw new PasswordPolicyError();

  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await deriveKey(password, salt);
  return [
    "scrypt",
    "1",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string | null | undefined,
): Promise<boolean> {
  const parts = encodedHash?.split("$");
  const validFormat =
    parts?.length === 7 &&
    parts[0] === "scrypt" &&
    parts[1] === "1" &&
    parts[2] === String(SCRYPT_N) &&
    parts[3] === String(SCRYPT_R) &&
    parts[4] === String(SCRYPT_P);

  if (!validFormat) {
    await deriveKey(password, DUMMY_SALT);
    return false;
  }

  const salt = Buffer.from(parts[5], "base64url");
  const expected = Buffer.from(parts[6], "base64url");
  if (
    salt.length !== SALT_LENGTH ||
    salt.toString("base64url") !== parts[5] ||
    expected.length !== KEY_LENGTH ||
    expected.toString("base64url") !== parts[6]
  ) {
    await deriveKey(password, DUMMY_SALT);
    return false;
  }

  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}
