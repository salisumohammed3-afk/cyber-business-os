// AES-256-GCM symmetric encryption for at-rest credential storage.
//
// The key is a 32-byte secret in process.env.INTEGRATIONS_ENCRYPTION_KEY,
// base64-encoded. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// then add to Vercel/Railway env vars.
//
// Wire format we store in the DB (jsonb):
//   { v: 1, iv: base64, tag: base64, ciphertext: base64 }
//
// Plaintext payload is whatever shape the auth_type expects, JSON-stringified
// before encryption:
//   api_key:  { key: "sk-..." }
//   bearer:   { token: "..." }
//   basic:    { username: "...", password: "..." }
//
// On decrypt, we JSON.parse back to the object.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;   // GCM standard
const TAG_LEN = 16;  // GCM standard

export interface EncryptedBlob {
  v: 1;
  iv: string;       // base64
  tag: string;      // base64
  ciphertext: string; // base64
}

function getKey(): Buffer {
  const raw = process.env.INTEGRATIONS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "INTEGRATIONS_ENCRYPTION_KEY env var is not set. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(
      `INTEGRATIONS_ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}. Did you base64-encode 32 random bytes?`
    );
  }
  return buf;
}

/** Encrypt a JSON-serializable payload. Returns the JSONB blob to store. */
export function encryptCredentials(plain: Record<string, unknown>): EncryptedBlob {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(plain), "utf8");
  const ct1 = cipher.update(plaintext);
  const ct2 = cipher.final();
  const ciphertext = Buffer.concat([ct1, ct2]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Decrypt a stored blob. Throws if tag mismatches (tampering). */
export function decryptCredentials(blob: EncryptedBlob): Record<string, unknown> {
  if (!blob || blob.v !== 1) {
    throw new Error("Encrypted blob has unsupported version: " + JSON.stringify(blob?.v));
  }
  const key = getKey();
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const ciphertext = Buffer.from(blob.ciphertext, "base64");
  if (iv.length !== IV_LEN) throw new Error("Invalid IV length");
  if (tag.length !== TAG_LEN) throw new Error("Invalid tag length");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt1 = decipher.update(ciphertext);
  const pt2 = decipher.final();
  const plaintext = Buffer.concat([pt1, pt2]).toString("utf8");
  return JSON.parse(plaintext);
}

/**
 * Build a masked preview suitable for showing to the user.
 *  "sk-abcd1234567890efghABCD"  ->  "sk-...ABCD"
 *  "ghp_AAAA...ZZZZ"            ->  "ghp_...ZZZZ"
 *  short tokens (<= 8 chars)    ->  "***"
 */
export function maskCredential(value: string): string {
  if (!value) return "***";
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "***";
  // Preserve a known prefix (sk-, ghp_, etc.) up to 4 alphanumeric chars + first separator
  const prefixMatch = trimmed.match(/^([A-Za-z]{1,5}[-_])/);
  const prefix = prefixMatch ? prefixMatch[1] : trimmed.slice(0, 2);
  const suffix = trimmed.slice(-4);
  return `${prefix}...${suffix}`;
}
