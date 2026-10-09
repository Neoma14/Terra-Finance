// Dijalankan sebelum `electron-builder` (lihat script "dist" di package.json).
// Kenapa perlu langkah terpisah ini (bukan langsung arahkan electron-builder
// ke apps/api): `apps/api/node_modules` pakai symlink khas pnpm (virtual
// store `.pnpm/` + symlink ABSOLUT ke sana) -- kalau di-copy electron-builder
// apa adanya, symlink itu tetap menunjuk ke path ABSOLUT di mesin developer
// ini, jadi installer yang dihasilkan HANYA jalan di mesin ini, rusak begitu
// dipasang di komputer klien (path beda). Sempat dicoba dereference-copy
// manual (fs.cpSync dereference:true) tapi itu meratakan folder TANPA
// menjaga struktur nested `.pnpm/<pkg>/node_modules/<transitive-dep>` yang
// dibutuhkan resolusi dependency transitif (kasus nyata: `@fastify/cors`
// butuh `mnemonist` yang cuma ada nested, bukan di top-level) -- gagal
// dengan MODULE_NOT_FOUND saat app.exe sungguhan dijalankan.
//
// Solusi yang benar-benar portable: `pnpm deploy` dengan
// `--config.node-linker=hoisted` -- hasilkan node_modules FLAT gaya
// npm/yarn klasik (semua dependency, termasuk transitif, jadi folder asli
// di top level node_modules, TANPA symlink sama sekali). Sudah diverifikasi
// end-to-end: app.exe hasil packaging jalan bersih (server start, semua
// endpoint 200) dari folder `dist/win-unpacked` yang berdiri sendiri.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const desktopDir = path.join(__dirname, "..");
const repoRoot = path.join(desktopDir, "..", "..");
const isWin = process.platform === "win32";

// Path RELATIF (bukan absolut) ke folder deploy -- proyek ini ada di bawah
// folder ber-spasi ("Proyek Aplikasi"), dan `execFileSync(..., {shell:true})`
// di Windows TIDAK meng-quote argumen dgn benar (beda dgn `spawn` biasa),
// jadi path absolut pecah di spasi jadi 2 argumen terpisah. Path relatif dari
// `desktopDir` (mis. "../../deploy/api-hoisted") tidak mengandung spasi sama
// sekali, jadi aman lewat shell tanpa perlu quoting manual.
const deployDirRelative = path.relative(desktopDir, path.join(repoRoot, "deploy", "api-hoisted"));

function run(cmd, args, cwd) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: isWin });
}


// Build ULANG frontend di sini, SETIAP kali "dist" dijalankan -- BUKAN
// tanggung jawab developer utk ingat jalankan `pnpm --filter @konsultan/web
// build` manual sebelum packaging. Sempat kejadian nyata: beberapa fitur baru
// (import Excel, tombol kembali, hapus akun) sudah ada di source & lolos
// typecheck, tapi installer yang dihasilkan tetap pakai bundle JS LAMA
// karena `apps/web/dist` tidak ikut di-build ulang -- electron-builder cuma
// nge-copy folder `apps/web/dist` apa adanya (lihat `extraResources` di
// package.json), tidak pernah menjalankan build react-nya sendiri.
run("pnpm", ["--filter", "@konsultan/web", "build"], repoRoot);

// TASK-DB-ARCH-018: build ULANG backend juga, utk alasan PERSIS SAMA dgn
// frontend di atas -- `pnpm --filter @konsultan/api deploy` (di bawah)
// HANYA menyalin file package (termasuk `dist/`) apa adanya, TIDAK
// menjalankan `tsc`. Tanpa baris ini, `apps/api/dist/server.js` yang
// ikut dikemas ke installer bisa STALE (versi lama, ketinggalan seluruh
// route yang ditambah task-task terakhir) kalau developer lupa jalankan
// `pnpm --filter @konsultan/api build` manual sebelum packaging --
// ditemukan via audit TASK-DB-ARCH-018, bukan asumsi.
run("pnpm", ["--filter", "@konsultan/api", "build"], repoRoot);

// `pnpm deploy` menolak nulis ke folder yg sudah ada isinya (dari run
// sebelumnya) -- bersihkan dulu supaya script ini aman dijalankan berkali2.
fs.rmSync(path.join(repoRoot, "deploy", "api-hoisted"), { recursive: true, force: true });

// `--config.package-import-method=copy`: percobaan pertama (TASK-DB-ARCH-018)
// mengira pnpm men-hard-link file store BERSAMA ke sini & itu sebab
// native binary WORKSPACE UTAMA ikut rusak stlh `@electron/rebuild` di
// bawah -- flag ini TERBUKTI TIDAK CUKUP (diverifikasi ulang: dgn flag
// ini SAJA, `pnpm test` di workspace utama tetap gagal NODE_MODULE_VERSION
// mismatch persis sama). Mekanisme pasti pnpm/node-gyp yang menyebabkan
// ini TIDAK dikonfirmasi lebih jauh (di luar scope task ini) -- dipakai
// pendekatan yang PASTI benar sbg gantinya: restore eksplisit di akhir
// script ini (lihat bawah), bukan bergantung pada asumsi isolasi yang
// gagal terbukti.
run(
  "pnpm",
  ["--filter", "@konsultan/api", "deploy", "--prod", "--config.node-linker=hoisted", "--config.package-import-method=copy", "deploy/api-hoisted"],
  repoRoot,
);

// Paket client TIDAK boleh membawa sumber TypeScript atau file test: runtime
// hanya memakai dist/server.js, sedangkan file test memuat fixture penandatanganan
// (crypto.sign) yang tidak boleh ada di installer. Lisensi hanya diverifikasi di client.
const deployedApi = path.join(repoRoot, "deploy", "api-hoisted");
fs.rmSync(path.join(deployedApi, "src"), { recursive: true, force: true });
// .env (dev/server) tidak boleh ikut ke installer: berisi konfigurasi lokal
// developer. Secret sesi produksi diberikan main.js lewat environment.
fs.rmSync(path.join(deployedApi, ".env"), { force: true });
// Folder data/ berisi database development (user, sesi, lisensi developer).
// Di produksi lokasi database diberikan main.js (userData), jadi folder ini
// tidak dipakai dan tidak boleh ikut ke installer.
fs.rmSync(path.join(deployedApi, "data"), { recursive: true, force: true });
// Skrip UAT dan konfigurasi test adalah alat developer, bukan bagian runtime.
for (const devFile of ["uat-runner.ts", "vitest.config.ts", ".env.example"]) {
  fs.rmSync(path.join(deployedApi, devFile), { force: true });
}
(function removeTestArtifacts(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removeTestArtifacts(full);
    else if (/\.test\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(entry.name)) fs.rmSync(full, { force: true });
  }
})(path.join(deployedApi, "dist"));

// Native module (better-sqlite3, argon2) hasil `pnpm deploy` di atas
// terkompilasi utk ABI Node SISTEM -- WAJIB di-rebuild khusus utk ABI Node
// yg dibundel Electron, kalau tidak app.exe crash dgn error
// NODE_MODULE_VERSION mismatch saat require(). Ini SATU-SATUNYA native
// rebuild yang diperlukan (`deploy/api-hoisted` SAJA) -- `apps/desktop`
// sendiri TIDAK punya native dependency apa pun (electron/electron-
// builder/electron-updater semuanya JS/binary-download biasa). Krn itu
// `"npmRebuild": false` di `package.json` ("build" field) SENGAJA
// dimatikan (TASK-DB-ARCH-018) -- langkah auto-rebuild BAWAAN electron-
// builder (beda dari `npx @electron/rebuild` eksplisit di bawah ini)
// gagal dgn ENOENT saat menelusuri `node_modules/.pnpm` milik WORKSPACE
// (bukan folder package ini), krn layout virtual-store pnpm membingungkan
// penelusur dependency electron-builder -- tidak relevan sama sekali,
// native module yg benar2 dipakai app sudah di-rebuild manual di atas.
run(
  "npx",
  ["@electron/rebuild", "-f", "-w", "better-sqlite3,argon2", "--module-dir", deployDirRelative],
  desktopDir,
);

// WAJIB (TASK-DB-ARCH-018, ditemukan via test nyata -- bukan pencegahan
// teoretis): langkah `@electron/rebuild` di atas TERBUKTI ikut merusak
// binary native `better-sqlite3`/`argon2` milik WORKSPACE UTAMA
// (`apps/api/node_modules`, dipakai `pnpm test`/`pnpm dev` biasa) --
// seluruh test backend gagal NODE_MODULE_VERSION mismatch stlh build
// desktop dijalankan, meski `deploy/api-hoisted` SUDAH dibuat via
// `--config.package-import-method=copy` (lihat komentar di atas -- flag
// itu TIDAK cukup, mekanisme pasti pnpm/node-gyp yg menyebabkannya TIDAK
// dikonfirmasi lebih jauh, di luar scope). Drpd bergantung pada isolasi
// yang gagal terbukti, restore EKSPLISIT di sini -- script packaging ini
// SELALU mengembalikan workspace utama ke ABI Node sistem sebelum selesai,
// supaya developer yang baru selesai `pnpm --filter @konsultan/desktop
// dist` tidak diam-diam mendapati `pnpm test`/`pnpm dev` miliknya rusak.
run("pnpm", ["--filter", "@konsultan/api", "rebuild", "better-sqlite3", "argon2"], repoRoot);

console.log("\nDeploy + rebuild native module selesai (termasuk restore ABI workspace utama) -- lanjut packaging electron-builder.\n");
