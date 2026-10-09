import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyLicenseKey, verifyAdministratorToken } from "./service.js";

// Keypair UJI (bukan keypair vendor). Membuktikan logika verifikasi menolak
// lisensi yang dipalsukan dengan key lain, dan menerima format yang benar.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const { publicKey: forgerPub, privateKey: forgerPriv } = crypto.generateKeyPairSync("ed25519");

function makeKey(overrides: Partial<Record<string, unknown>> = {}, signer = privateKey): string {
  const payload = {
    v: 2,
    lid: "TFL-TEST0001",
    client: "PT UJI",
    product: "TERRA FINANCE",
    expiry: null,
    devices: 1,
    issued: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.sign(null, Buffer.from(b64, "utf8"), signer).toString("base64url");
  return `TFO2-${b64}.${sig}`;
}

describe("verifyLicenseKey (client, Ed25519 offline)", () => {
  it("menerima lisensi lifetime yang ditandatangani kunci yang benar", () => {
    const res = verifyLicenseKey(makeKey(), publicKey);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.payload.client).toBe("PT UJI");
      expect(res.payload.expiry).toBeNull();
      expect(res.payload.devices).toBe(1);
    }
  });

  it("menerima lisensi dengan tanggal expiry (dibaca utk status, bukan di sini)", () => {
    const res = verifyLicenseKey(makeKey({ expiry: "2030-12-31" }), publicKey);
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.payload.expiry).toBe("2030-12-31");
  });

  it("menolak lisensi yang payload-nya diubah (tanda tangan tidak cocok)", () => {
    const good = makeKey({ devices: 1 });
    const [prefix, rest] = [good.slice(0, 5), good.slice(5)];
    const [, sig] = rest.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ v: 2, lid: "X", client: "PT UJI", product: "TERRA FINANCE", expiry: null, devices: 999, issued: "x" }), "utf8").toString("base64url");
    const res = verifyLicenseKey(`${prefix}${forgedPayload}.${sig}`, publicKey);
    expect(res.valid).toBe(false);
  });

  it("menolak lisensi yang ditandatangani kunci lain (palsu)", () => {
    const res = verifyLicenseKey(makeKey({}, forgerPriv), publicKey);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.reason).toMatch(/palsu|diubah/);
  });

  it("menolak prefix/format rusak", () => {
    expect(verifyLicenseKey("TFO-XXXX-XXXX", publicKey).valid).toBe(false);
    expect(verifyLicenseKey("TFO2-tanpa-titik", publicKey).valid).toBe(false);
    expect(verifyLicenseKey("", publicKey).valid).toBe(false);
  });

  it("menolak lisensi untuk produk lain", () => {
    const res = verifyLicenseKey(makeKey({ product: "LAIN" }), publicKey);
    expect(res.valid).toBe(false);
  });

  it("menolak activation policy tidak valid (devices < 1)", () => {
    const res = verifyLicenseKey(makeKey({ devices: 0 }), publicKey);
    expect(res.valid).toBe(false);
  });

  it("toleran spasi di sekitar kunci (copy-paste)", () => {
    expect(verifyLicenseKey(`  ${makeKey()}  \n`, publicKey).valid).toBe(true);
  });
});

describe("verifyAdministratorToken (token vendor)", () => {
  const LK = "TFO2-LICENSE-KEY-UJI";
  function tokenFor(licenseKey: string, signer = privateKey): string {
    return crypto.sign(null, Buffer.from("ADMIN|" + licenseKey.trim().toUpperCase(), "utf8"), signer).toString("base64url");
  }

  it("menerima token yang ditandatangani vendor untuk lisensi yang sama", () => {
    expect(verifyAdministratorToken(LK, tokenFor(LK), publicKey)).toBe(true);
  });

  it("menolak token untuk lisensi lain (tidak bisa dipakai lintas instalasi)", () => {
    expect(verifyAdministratorToken("TFO2-LAIN", tokenFor(LK), publicKey)).toBe(false);
  });

  it("menolak token yang ditandatangani kunci palsu", () => {
    expect(verifyAdministratorToken(LK, tokenFor(LK, forgerPriv), publicKey)).toBe(false);
  });

  it("menolak token kosong/rusak tanpa melempar error", () => {
    expect(verifyAdministratorToken(LK, "bukan-token", publicKey)).toBe(false);
  });
});
