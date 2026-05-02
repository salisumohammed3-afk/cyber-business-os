import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { signJwtEs256, signAppStoreConnectJwt } from "../../api/lib/jwt-es256.mjs";

// Generate a throw-away P-256 key for tests so we can sign + verify without
// needing the real Apple .p8 in CI.
function generateTestKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKey,
  };
}

function decodeJwtParts(jwt: string) {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const decode = (s: string) => {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded, "base64").toString("utf8");
  };
  return {
    header: JSON.parse(decode(parts[0])),
    claims: JSON.parse(decode(parts[1])),
    signatureB64Url: parts[2],
    signingInput: `${parts[0]}.${parts[1]}`,
  };
}

describe("jwt-es256: signJwtEs256", () => {
  it("produces a 3-part compact JWT", () => {
    const { privateKey } = generateTestKey();
    const jwt = signJwtEs256({
      keyId: "ABCD1234",
      issuer: "00000000-0000-0000-0000-000000000000",
      privateKeyPem: privateKey,
      audience: "appstoreconnect-v1",
    });
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("header has alg=ES256 + kid + typ=JWT", () => {
    const { privateKey } = generateTestKey();
    const jwt = signJwtEs256({
      keyId: "MYKID",
      issuer: "11111111-1111-1111-1111-111111111111",
      privateKeyPem: privateKey,
      audience: "appstoreconnect-v1",
    });
    const { header } = decodeJwtParts(jwt);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("MYKID");
    expect(header.typ).toBe("JWT");
  });

  it("claims include iss, iat, exp, aud", () => {
    const { privateKey } = generateTestKey();
    const before = Math.floor(Date.now() / 1000);
    const jwt = signJwtEs256({
      keyId: "K1",
      issuer: "issuer-uuid",
      privateKeyPem: privateKey,
      audience: "appstoreconnect-v1",
      ttlSeconds: 600,
    });
    const after = Math.floor(Date.now() / 1000);
    const { claims } = decodeJwtParts(jwt);
    expect(claims.iss).toBe("issuer-uuid");
    expect(claims.aud).toBe("appstoreconnect-v1");
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after);
    expect(claims.exp - claims.iat).toBe(600);
  });

  it("signature uses IEEE P-1363 (64 bytes for P-256), not DER", () => {
    const { privateKey } = generateTestKey();
    const jwt = signJwtEs256({
      keyId: "K1",
      issuer: "iss",
      privateKeyPem: privateKey,
      audience: "appstoreconnect-v1",
    });
    const { signatureB64Url } = decodeJwtParts(jwt);
    const padded = signatureB64Url.replace(/-/g, "+").replace(/_/g, "/");
    const sig = Buffer.from(padded, "base64");
    // P-256 IEEE P-1363 = exactly 64 bytes. DER would be 70-72 bytes typically.
    expect(sig.length).toBe(64);
  });

  it("signature verifies with the matching public key", () => {
    const { privateKey, publicKey } = generateTestKey();
    const jwt = signJwtEs256({
      keyId: "K1",
      issuer: "iss",
      privateKeyPem: privateKey,
      audience: "appstoreconnect-v1",
    });
    const { signingInput, signatureB64Url } = decodeJwtParts(jwt);
    const padded = signatureB64Url.replace(/-/g, "+").replace(/_/g, "/");
    const sig = Buffer.from(padded, "base64");
    const verifier = createVerify("SHA256");
    verifier.update(signingInput);
    verifier.end();
    const ok = verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, sig);
    expect(ok).toBe(true);
  });

  it("rejects ttl > 1200s (Apple max)", () => {
    const { privateKey } = generateTestKey();
    expect(() =>
      signJwtEs256({
        keyId: "K1", issuer: "iss", privateKeyPem: privateKey,
        audience: "appstoreconnect-v1", ttlSeconds: 1500,
      })
    ).toThrow(/20 minutes/);
  });

  it("rejects ttl < 60s", () => {
    const { privateKey } = generateTestKey();
    expect(() =>
      signJwtEs256({
        keyId: "K1", issuer: "iss", privateKeyPem: privateKey,
        audience: "appstoreconnect-v1", ttlSeconds: 30,
      })
    ).toThrow(/>= 60/);
  });

  it("rejects missing required fields", () => {
    const { privateKey } = generateTestKey();
    expect(() => signJwtEs256({ keyId: "", issuer: "iss", privateKeyPem: privateKey, audience: "x" }))
      .toThrow(/keyId/);
    expect(() => signJwtEs256({ keyId: "K", issuer: "", privateKeyPem: privateKey, audience: "x" }))
      .toThrow(/issuer/);
    expect(() => signJwtEs256({ keyId: "K", issuer: "iss", privateKeyPem: "", audience: "x" }))
      .toThrow(/privateKeyPem/);
  });

  it("handles escaped \\n in PEM (env var form)", () => {
    const { privateKey } = generateTestKey();
    const escaped = privateKey.replace(/\n/g, "\\n");
    // Should not throw — handler converts \\n -> \n internally
    expect(() =>
      signJwtEs256({
        keyId: "K", issuer: "iss", privateKeyPem: escaped, audience: "x",
      })
    ).not.toThrow();
  });
});

describe("jwt-es256: signAppStoreConnectJwt convenience wrapper", () => {
  it("uses appstoreconnect-v1 audience", () => {
    const { privateKey } = generateTestKey();
    const jwt = signAppStoreConnectJwt("K1", "iss", privateKey);
    const { claims } = decodeJwtParts(jwt);
    expect(claims.aud).toBe("appstoreconnect-v1");
  });

  it("ttl is 1200 seconds (Apple max)", () => {
    const { privateKey } = generateTestKey();
    const jwt = signAppStoreConnectJwt("K1", "iss", privateKey);
    const { claims } = decodeJwtParts(jwt);
    expect(claims.exp - claims.iat).toBe(1200);
  });
});
