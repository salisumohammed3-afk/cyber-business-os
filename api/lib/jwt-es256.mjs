// ES256 JWT signer for Apple-style APIs (App Store Connect, MapKit, MusicKit, etc.).
// Pure ES module, uses node:crypto only. No external deps.
//
// Apple specifically requires:
//   - Algorithm: ES256 (ECDSA P-256 + SHA-256)
//   - Signature encoding: IEEE P-1363 (raw r||s, 64 bytes) — NOT DER, which is Node's default
//   - JWT max lifetime: 20 minutes for App Store Connect
//
// Used by:
//   - api/integrations.ts probe         (POST/GET test against the vendor)
//   - api/agent-scripts/runner.mjs       (call_integration tool dispatch)

import { createSign } from "node:crypto";

function base64url(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Sign a JWT using ES256 (ECDSA-P256 with SHA-256), in JWT-compatible IEEE P-1363 format.
 *
 * @param {object} opts
 * @param {string} opts.keyId        kid header claim (Apple "Key ID")
 * @param {string} opts.issuer       iss claim (Apple "Issuer ID")
 * @param {string} opts.privateKeyPem .p8 private key file contents, including BEGIN/END markers
 * @param {string} opts.audience     aud claim (e.g. "appstoreconnect-v1" for ASC)
 * @param {number} [opts.ttlSeconds] token lifetime in seconds (max 1200 = 20 min for ASC)
 * @returns {string} compact JWT
 */
export function signJwtEs256({ keyId, issuer, privateKeyPem, audience, ttlSeconds = 1200 }) {
  if (!keyId) throw new Error("keyId is required");
  if (!issuer) throw new Error("issuer is required");
  if (!privateKeyPem) throw new Error("privateKeyPem is required");
  if (!audience) throw new Error("audience is required");
  if (ttlSeconds < 60) throw new Error("ttlSeconds must be >= 60");
  if (ttlSeconds > 1200) throw new Error("ttlSeconds > 1200 — Apple JWT max lifetime is 20 minutes");

  // Apple's docs use a literal newline-separated PEM. Some env vars / form inputs
  // store the body with escaped \n — handle both forms transparently.
  const pem = privateKeyPem.includes("\\n")
    ? privateKeyPem.replace(/\\n/g, "\n")
    : privateKeyPem;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const claims = { iss: issuer, iat: now, exp: now + ttlSeconds, aud: audience };

  const headerB64 = base64url(JSON.stringify(header));
  const claimsB64 = base64url(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  // dsaEncoding: "ieee-p1363" produces the raw r||s 64-byte signature JWT requires.
  // Without this, Node defaults to DER which Apple rejects.
  const signature = signer.sign({ key: pem, dsaEncoding: "ieee-p1363" });

  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Convenience wrapper for App Store Connect specifically.
 */
export function signAppStoreConnectJwt(keyId, issuerId, privateKeyPem) {
  return signJwtEs256({
    keyId,
    issuer: issuerId,
    privateKeyPem,
    audience: "appstoreconnect-v1",
    ttlSeconds: 1200,
  });
}
