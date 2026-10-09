import crypto from "node:crypto";
import type { Knex } from "knex";
import { computeInstanceFingerprint } from "./fingerprint.js";
import { LICENSE_PUBLIC_KEY_PEM } from "./license-public-key.js";

// Format lisensi v2 (Ed25519). Harus sama persis dengan sisi vendor (tool
// penerbit lisensi, terpisah dari aplikasi). Hanya PUBLIC key yang ada di
// aplikasi ini: client bisa memverifikasi lisensi, tidak bisa membuatnya.
// Tidak ada secret bersama di aplikasi.
const LICENSE_PREFIX = "TFO2-";
const PRODUCT = "TERRA FINANCE";
const FORMAT_VERSION = 2;
const ADMIN_TOKEN_PREFIX = "ADMIN|";

const embeddedPublicKey = crypto.createPublicKey(LICENSE_PUBLIC_KEY_PEM);

export interface LicensePayload {
  v: number;
  lid: string;
  client: string;
  product: string;
  expiry: string | null;
  devices: number;
  issued: string;
}

export type LicenseVerification = { valid: true; payload: LicensePayload } | { valid: false; reason: string };

export function verifyLicenseKey(licenseKey: string, publicKey: crypto.KeyObject = embeddedPublicKey): LicenseVerification {
  const trimmed = (licenseKey ?? "").trim();
  if (!trimmed.startsWith(LICENSE_PREFIX)) return { valid: false, reason: "Format kode lisensi tidak dikenali" };
  const parts = trimmed.slice(LICENSE_PREFIX.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: "Format kode lisensi tidak valid" };
  const [payloadB64, sigB64] = parts;

  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(payloadB64, "utf8"), publicKey, Buffer.from(sigB64, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) return { valid: false, reason: "Tanda tangan lisensi tidak valid (lisensi palsu atau sudah diubah)" };

  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "Isi lisensi rusak" };
  }
  if (payload.v !== FORMAT_VERSION || payload.product !== PRODUCT) {
    return { valid: false, reason: "Lisensi bukan untuk produk ini" };
  }
  if (!Number.isInteger(payload.devices) || payload.devices < 1) {
    return { valid: false, reason: "Activation policy lisensi tidak valid" };
  }
  return { valid: true, payload };
}

/** Token Administrator (maintenance vendor) -- ditandatangani vendor, bukan HMAC secret bersama. */
export function verifyAdministratorToken(licenseKey: string, token: string, publicKey: crypto.KeyObject = embeddedPublicKey): boolean {
  const msg = ADMIN_TOKEN_PREFIX + licenseKey.trim().toUpperCase();
  try {
    return crypto.verify(null, Buffer.from(msg, "utf8"), publicKey, Buffer.from(token.trim(), "base64url"));
  } catch {
    return false;
  }
}

function isExpired(expiry: string | null, now: number = Date.now()): boolean {
  if (!expiry) return false;
  return now > Date.parse(`${expiry}T23:59:59.999Z`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sisa hari penuh sampai lisensi berakhir (akhir hari expiry, UTC): 0 = masih
 * berlaku tetapi berakhir dalam kurang dari 24 jam. Null untuk Lifetime.
 * Negatif bila sudah lewat. */
export function daysUntilExpiry(expiry: string | null, now: number = Date.now()): number | null {
  if (!expiry) return null;
  const diff = Date.parse(`${expiry}T23:59:59.999Z`) - now;
  return diff >= 0 ? Math.floor(diff / DAY_MS) : -Math.ceil(-diff / DAY_MS);
}

export interface LicenseStatus {
  activated: boolean;
  clientName: string | null;
  product: string | null;
  status: "active" | "expired" | "invalid" | "device_mismatch" | null;
  expiresAt: string | null;
  activationDevices: number | null;
  fingerprintMatches: boolean | null;
  reason: string | null;
  /** Sisa hari penuh (null = Lifetime / belum aktif; negatif = sudah lewat). */
  daysRemaining: number | null;
}

const NOT_ACTIVATED: LicenseStatus = {
  activated: false,
  clientName: null,
  product: null,
  status: null,
  expiresAt: null,
  activationDevices: null,
  fingerprintMatches: null,
  reason: null,
  daysRemaining: null,
};

export async function getLicenseStatus(
  db: Knex,
  opts: { publicKey?: crypto.KeyObject; now?: number } = {},
): Promise<LicenseStatus> {
  const row = await db("license").first();
  if (!row) return NOT_ACTIVATED;
  const now = opts.now ?? Date.now();

  const verified = verifyLicenseKey(row.license_key, opts.publicKey);
  if (!verified.valid) {
    return { ...NOT_ACTIVATED, activated: true, clientName: row.client_name, status: "invalid", reason: verified.reason };
  }
  const p = verified.payload;
  const fingerprintMatches = row.instance_fingerprint === computeInstanceFingerprint();
  const base = {
    activated: true,
    clientName: p.client,
    product: p.product,
    expiresAt: p.expiry,
    activationDevices: p.devices,
    fingerprintMatches,
    daysRemaining: daysUntilExpiry(p.expiry, now),
  };
  if (!fingerprintMatches) {
    return { ...base, status: "device_mismatch", reason: "Lisensi ini terikat ke komputer lain." };
  }
  if (isExpired(p.expiry, now)) {
    return { ...base, status: "expired", reason: `Lisensi berakhir pada ${p.expiry}.` };
  }
  return { ...base, status: "active", reason: null };
}

/** True hanya kalau lisensi terpasang, valid signature, belum expired, dan terikat ke mesin ini. */
export async function isLicenseUsable(db: Knex): Promise<boolean> {
  const status = await getLicenseStatus(db);
  return status.status === "active";
}

export async function activateLicense(db: Knex, licenseKey: string): Promise<void> {
  const verified = verifyLicenseKey(licenseKey);
  if (!verified.valid) throw new Error(verified.reason);
  if (isExpired(verified.payload.expiry)) throw new Error(`Lisensi berakhir pada ${verified.payload.expiry}.`);

  const existing = await db("license").first();
  if (existing) throw new Error("Instalasi ini sudah diaktivasi. Gunakan penggantian lisensi jika perlu.");

  await db("license").insert({
    id: crypto.randomUUID(),
    license_key: licenseKey.trim(),
    client_name: verified.payload.client,
    instance_fingerprint: computeInstanceFingerprint(),
    status: "active",
  });
}

/** Penggantian lisensi (mis. perpanjangan / lisensi baru dari vendor). Hanya lisensi valid.
 * Hapus + simpan dalam SATU transaksi: bila penyimpanan gagal, lisensi lama tetap utuh. */
export async function replaceLicense(
  db: Knex,
  licenseKey: string,
  opts: { publicKey?: crypto.KeyObject; now?: number } = {},
): Promise<LicensePayload> {
  const verified = verifyLicenseKey(licenseKey, opts.publicKey);
  if (!verified.valid) throw new Error(verified.reason);
  if (isExpired(verified.payload.expiry, opts.now)) throw new Error(`Lisensi pengganti sudah berakhir pada ${verified.payload.expiry}.`);

  await db.transaction(async (trx) => {
    await trx("license").del();
    await trx("license").insert({
      id: crypto.randomUUID(),
      license_key: licenseKey.trim(),
      client_name: verified.payload.client,
      instance_fingerprint: computeInstanceFingerprint(),
      status: "active",
    });
  });
  return verified.payload;
}

export type LicenseInspection =
  | { valid: false; reason: string }
  | {
      valid: true;
      payload: { licenseId: string; clientName: string; expiry: string | null; devices: number; issued: string };
      expired: boolean;
      daysRemaining: number | null;
      /** Nama klien sama dengan lisensi terpasang (tanpa beda huruf besar/kecil & spasi). Null bila belum ada lisensi terpasang. */
      sameClient: boolean | null;
      /** Berlaku lebih singkat dari lisensi terpasang (mis. Lifetime -> bertanggal). */
      shorterThanCurrent: boolean;
    };

const normName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Periksa kunci lisensi TANPA menyimpan apa pun -- dipakai UI Perpanjang untuk
 * menampilkan isi kunci dan memperingatkan sebelum pengguna menerapkannya. */
export async function inspectLicense(
  db: Knex,
  licenseKey: string,
  opts: { publicKey?: crypto.KeyObject; now?: number } = {},
): Promise<LicenseInspection> {
  const verified = verifyLicenseKey(licenseKey, opts.publicKey);
  if (!verified.valid) return { valid: false, reason: verified.reason };
  const p = verified.payload;
  const now = opts.now ?? Date.now();

  const row = await db("license").first();
  let sameClient: boolean | null = null;
  let shorterThanCurrent = false;
  if (row) {
    const current = verifyLicenseKey(row.license_key, opts.publicKey);
    const currentClient = current.valid ? current.payload.client : row.client_name;
    sameClient = normName(String(currentClient ?? "")) === normName(p.client);
    if (current.valid) {
      const curEnd = current.payload.expiry ? Date.parse(`${current.payload.expiry}T23:59:59.999Z`) : Infinity;
      const newEnd = p.expiry ? Date.parse(`${p.expiry}T23:59:59.999Z`) : Infinity;
      shorterThanCurrent = newEnd < curEnd;
    }
  }
  return {
    valid: true,
    payload: { licenseId: p.lid, clientName: p.client, expiry: p.expiry, devices: p.devices, issued: p.issued },
    expired: isExpired(p.expiry, now),
    daysRemaining: daysUntilExpiry(p.expiry, now),
    sameClient,
    shorterThanCurrent,
  };
}
