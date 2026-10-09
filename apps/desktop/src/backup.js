"use strict";
/**
 * Backup & restore data TERRA FINANCE. Modul murni Node (tanpa Electron)
 * supaya bisa diuji otomatis.
 *
 * Yang dicadangkan (folder data pengguna):
 *   terra-finance.sqlite              -> backups/terra-finance-<ts>.sqlite   (pola lama dipertahankan)
 *   terra-system.sqlite               -> backups/terra-system-<ts>.sqlite
 *   companies/<slug>/company.db       -> backups/companies/<slug>/company-<ts>.db
 *
 * Konfigurasi perusahaan, saldo, jurnal, dan audit log semuanya ada DI DALAM
 * company.db (tidak ada file konfigurasi terpisah), jadi cukup itu.
 *
 * Aturan:
 *  - Format timestamp sama seperti sebelumnya (ISO, ":" dan "." jadi "-").
 *  - Database yang tidak berubah sejak backup terakhirnya DILEWATI (tidak ada
 *    salinan ganda yang tidak perlu).
 *  - Retensi 30 hari seperti sebelumnya, TETAPI backup terbaru tiap database
 *    tidak pernah dihapus (database yang jarang berubah tidak boleh
 *    kehilangan satu-satunya backup-nya).
 *  - File pendamping SQLite (-journal/-wal/-shm) ikut disalin bila ada supaya
 *    salinan yang diambil saat aplikasi sedang menulis tetap bisa dipulihkan
 *    oleh SQLite.
 */
const fs = require("node:fs");
const path = require("node:path");

const RETENTION_DAYS = 30;
const SIDECARS = ["-journal", "-wal", "-shm"];

function timestampNow(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function copyWithSidecars(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  for (const suffix of SIDECARS) {
    if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dest + suffix);
  }
}

/** Daftar sumber data yang ada di disk. */
function listSources(userDataDir) {
  const sources = [];
  const master = path.join(userDataDir, "terra-finance.sqlite");
  const system = path.join(userDataDir, "terra-system.sqlite");
  if (fs.existsSync(master)) sources.push({ key: "master", src: master, dir: "", prefix: "terra-finance-", ext: ".sqlite" });
  if (fs.existsSync(system)) sources.push({ key: "system", src: system, dir: "", prefix: "terra-system-", ext: ".sqlite" });
  const companiesRoot = path.join(userDataDir, "companies");
  if (fs.existsSync(companiesRoot)) {
    for (const entry of fs.readdirSync(companiesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const src = path.join(companiesRoot, entry.name, "company.db");
      if (fs.existsSync(src)) sources.push({ key: "company:" + entry.name, src, dir: path.join("companies", entry.name), prefix: "company-", ext: ".db", slug: entry.name });
    }
  }
  return sources;
}

/** Backup terbaru (nama file + mtime) untuk satu sumber, atau null. */
function newestBackup(backupDir, source) {
  const dir = path.join(backupDir, source.dir);
  if (!fs.existsSync(dir)) return null;
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(source.prefix) && n.endsWith(source.ext))
    .sort();
  if (names.length === 0) return null;
  const name = names[names.length - 1];
  return { name, path: path.join(dir, name), mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs };
}

function sidecarsNewerThan(src, ms) {
  return SIDECARS.some((s) => fs.existsSync(src + s) && fs.statSync(src + s).mtimeMs > ms);
}

function runBackup(userDataDir, opts = {}) {
  const backupDir = opts.backupDir ?? path.join(userDataDir, "backups");
  const ts = timestampNow(opts.now);
  const copied = [];
  const skipped = [];
  fs.mkdirSync(backupDir, { recursive: true });

  for (const source of listSources(userDataDir)) {
    const latest = newestBackup(backupDir, source);
    const changed = !latest || fs.statSync(source.src).mtimeMs > latest.mtimeMs || sidecarsNewerThan(source.src, latest.mtimeMs);
    if (!changed) {
      skipped.push(source.key);
      continue;
    }
    const dest = path.join(backupDir, source.dir, source.prefix + ts + source.ext);
    copyWithSidecars(source.src, dest);
    copied.push(path.relative(backupDir, dest));
  }

  applyRetention(backupDir, listSourcesFromBackups(backupDir), opts.retentionDays ?? RETENTION_DAYS, opts.nowMs ?? Date.now());
  return { copied, skipped, backupDir };
}

/** Semua kelompok backup yang ada di folder backup (untuk retensi & restore). */
function listSourcesFromBackups(backupDir) {
  const groups = [];
  if (!fs.existsSync(backupDir)) return groups;
  groups.push({ key: "master", dir: "", prefix: "terra-finance-", ext: ".sqlite", target: "terra-finance.sqlite" });
  groups.push({ key: "system", dir: "", prefix: "terra-system-", ext: ".sqlite", target: "terra-system.sqlite" });
  const companiesDir = path.join(backupDir, "companies");
  if (fs.existsSync(companiesDir)) {
    for (const entry of fs.readdirSync(companiesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) groups.push({ key: "company:" + entry.name, dir: path.join("companies", entry.name), prefix: "company-", ext: ".db", target: path.join("companies", entry.name, "company.db") });
    }
  }
  return groups;
}

function backupsOf(backupDir, group) {
  const dir = path.join(backupDir, group.dir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(group.prefix) && n.endsWith(group.ext))
    .sort();
}

function applyRetention(backupDir, groups, retentionDays, nowMs) {
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  for (const group of groups) {
    const names = backupsOf(backupDir, group);
    // backup terbaru (elemen terakhir) selalu dipertahankan
    for (const name of names.slice(0, -1)) {
      const full = path.join(backupDir, group.dir, name);
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        for (const s of SIDECARS) if (fs.existsSync(full + s)) fs.unlinkSync(full + s);
      }
    }
  }
}

/**
 * Pulihkan backup ke folder data `targetDir` (HARUS folder baru/kosong atau
 * dengan overwrite eksplisit -- tidak pernah menimpa diam-diam). Per database
 * dipilih backup terbaru yang timestamp-nya <= `timestamp` (default: terbaru).
 */
function restoreBackup(backupDir, targetDir, opts = {}) {
  const restored = [];
  for (const group of listSourcesFromBackups(backupDir)) {
    const candidates = backupsOf(backupDir, group).filter((n) => !opts.timestamp || n.slice(group.prefix.length, -group.ext.length) <= opts.timestamp);
    if (candidates.length === 0) continue;
    const name = candidates[candidates.length - 1];
    const dest = path.join(targetDir, group.target);
    if (fs.existsSync(dest) && !opts.overwrite) {
      throw new Error("Tujuan sudah berisi " + group.target + ". Gunakan folder kosong atau overwrite eksplisit.");
    }
    copyWithSidecars(path.join(backupDir, group.dir, name), dest);
    restored.push(group.target);
  }
  return { restored };
}

module.exports = { runBackup, restoreBackup, listSources, timestampNow, RETENTION_DAYS };
