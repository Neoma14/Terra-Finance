// Proses utama Electron -- menjalankan server Fastify (apps/api) sbg
// child process lokal, menunggu server siap, lalu membuka BrowserWindow
// yang me-load-nya. Server JUGA menyajikan frontend React yang sudah
// di-build (lihat STATIC_WEB_DIR di bawah) -- satu proses server, satu
// origin, tidak perlu proses/port terpisah utk frontend di produksi.
//
// SENGAJA CommonJS (bukan "type": "module" + import/export) -- proses
// utama Electron & ekosistemnya (electron-builder, sebagian native
// binding) jauh lebih matang & teruji dgn CommonJS; sempat dicoba ESM
// dan gagal dgn error loader internal Node yang tidak jelas
// (`cjsPreparseModuleExports` TypeError) di electron@33's bundled Node 20.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backup = require("./backup.js");

// WAJIB dipanggil SEBELUM app.getPath('userData') di bawah -- tanpa ini,
// Electron jatuh balik ke field "name" package.json ("@konsultan/desktop",
// nama paket npm internal) utk nama folder userData, bukan "productName"
// ("TERRA FINANCE"). Ketahuan lewat testing nyata: folder data klien
// muncul sbg "AppData/Roaming/@konsultan/desktop" -- membingungkan &
// tidak profesional utk produk yg dijual ke klien.
app.setName("TERRA FINANCE");

// WAJIB dipanggil SEBELUM app.whenReady() -- fix utk bug nyata yg dilaporkan
// klien: "install tapi yang tampil hanya putih semua" (window terbuka tapi
// blank/putih, padahal server & asset JS/CSS terkonfirmasi sehat lewat
// pengujian langsung thd server packaged -- index.html, bundle JS, CSS semua
// 200 OK). Penyebab paling umum utk gejala PERSIS ini di Electron+Windows
// adalah proses GPU Chromium gagal render (driver GPU lama/bermasalah, mesin
// VM, atau sesi Remote Desktop) -- window tetap terbuka tapi isinya tidak
// pernah ter-paint. `disableHardwareAcceleration()` adalah mitigasi resmi
// yang direkomendasikan Electron sendiri utk gejala ini. Dipasang di sini
// (bukan cuma disarankan ke klien via flag command-line) supaya semua
// instalasi klien otomatis terlindungi tanpa perlu klien tahu cara
// menjalankan exe dengan argumen tambahan.
//
// SUSULAN: `disableHardwareAcceleration()` SAJA TERBUKTI TIDAK CUKUP --
// bug "putih semua" masih dilaporkan muncul lagi stlh build dgn fix di
// atas. Diuji ulang: server + React build SENDIRI terkonfirmasi sehat
// (headless Chromium via Playwright berhasil me-render halaman Setup
// Awal dgn SEMPURNA, nol console error/page error/failed request) --
// artinya bug bukan di kode JS/CSS/server, melainkan spesifik di proses
// render Chromium milik Electron di mesin ybs. Ditambahkan switch
// command-line eksplisit di bawah (bukan cuma API call bawaan) krn
// sejumlah kasus Windows (GPU driver lama/bermasalah, VM, sesi Remote
// Desktop) TERBUKTI butuh kombinasi flag ini, tidak cukup hanya
// `disableHardwareAcceleration()` -- pola umum yg dipakai banyak app
// Electron lain utk kasus serupa yang "keras kepala".
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-software-rasterizer");

// Dev: `apps/api`/`apps/web` adalah sibling folder dari `apps/desktop` ini
// (jalan langsung dari source monorepo). Packaged: electron-builder menaruh
// hasil `pnpm deploy` punya `apps/api` (node_modules sudah di-dereference,
// bukan symlink pnpm yg nunjuk keluar) & `apps/web/dist` sbg `extraResources`
// di `resources/api` & `resources/web/dist` (lihat "build.extraResources" di
// package.json) -- KELUAR dari app.asar supaya native module (.node) & child
// process `node dist/server.js` bisa diakses sbg file biasa di disk.
const appsRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "..");
const apiServerPath = path.join(appsRoot, "api", "dist", "server.js");
const webDistPath = path.join(appsRoot, "web", "dist");

const userDataDir = app.getPath("userData");

// Logger diagnostik bersama -- SATU file (bukan dipisah per-fitur) supaya
// urutan kejadian (server api start/crash vs renderer load) bisa dibaca
// kronologis saat debugging laporan klien dari jarak jauh. Ditambahkan
// krn ditemukan lewat test nyata (laporan "putih semua" dari klien):
// window Electron gagal connect ke server (location.href jatuh ke
// "chrome-error://chromewebdata/", halaman kosong) TANPA jejak apa pun
// sebelumnya -- stdout/stderr proses api HANYA ditulis ke
// process.stdout/stderr milik main process, yang LENYAP tanpa jejak di
// app packaged (tidak ada console window yg terlihat klien).
const diagLogPath = path.join(userDataDir, "diagnostic.log");
function logDiag(line) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.appendFileSync(diagLogPath, new Date().toISOString() + " " + line + "\n");
  } catch (err) {
    // Tidak fatal -- cuma kehilangan jejak diagnostik, app tetap lanjut.
  }
}

const dbFilePath = path.join(userDataDir, "terra-finance.sqlite");
// TASK-DB-ARCH-018: SEBELUM task ini, main.js TIDAK mengisi kedua
// variabel ini sama sekali (lihat komentar lama di
// `config/env.ts` -- "main.js BELUM diubah utk mengisi variabel ini").
// Akibatnya server production diam-diam jatuh ke default
// `./data/terra-system.sqlite`/`./data/companies` (RELATIF thd cwd
// proses, yang TIDAK predictable utk app yg dibuka lewat klik ganda --
// bisa jadi folder install, bisa beda2) -- padahal SELURUH fitur baru
// (Company Access, COA, Opening Balance, Journal, Ledger, Trial Balance,
// Financial Reports -- TASK-DB-ARCH-002 s/d 017) bergantung pada System
// DB & Company DB ini. Ditemukan lewat audit TASK-DB-ARCH-018, BUKAN
// asumsi -- diperbaiki di sini, lokasi SAMA amannya dgn `dbFilePath` di
// atas (`userData`, bukan folder install Program Files).
const systemDbFilePath = path.join(userDataDir, "terra-system.sqlite");
const companyDataRoot = path.join(userDataDir, "companies");

/** SESSION_SECRET acak PER-INSTALASI, dibuat sekali & disimpan permanen di
 * `userData`. Dipakai juga utk menandatangani sesi Administrator. Kalau secret
 * sama di semua instalasi, cookie dari SATU klien bisa dipalsukan utk klien lain
 * yang pakai installer yang sama persis -- harus unik per mesin. */
function getOrCreateSessionSecret() {
  const secretPath = path.join(userDataDir, "session-secret.txt");
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, "utf-8").trim();
  }
  const secret = crypto.randomBytes(48).toString("hex");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}



let apiProcess = null;
let mainWindow = null;

// 15 detik (nilai lama) TERBUKTI TIDAK CUKUP lewat laporan klien nyata &
// diagnostic.log sungguhan: proses api di salah satu mesin klien baru
// benar2 "Server listening" ~40 detik stlh di-spawn (kemungkinan besar
// Windows Defender melakukan scan sinkron thd exe yg baru diekstrak
// installer & belum punya reputasi/tanda tangan kode -- ini perilaku
// Windows yg terdokumentasi utk executable baru/unsigned). Akibatnya dulu:
// waitForServerReady nyerah di detik ke-15, lalu loadURL dipanggil SEKALI
// ke server yg BELUM listening -> ERR_CONNECTION_REFUSED permanen (window
// tidak pernah retry loadURL stlh itu, walopun server akhirnya jalan baik
// 25 detik kemudian). 90 detik dipilih dgn margin ~2x dari waktu terlama
// yg benar2 terukur (40 detik), bukan angka tebakan.
function waitForServerReady(port, timeoutMs) {
  timeoutMs = timeoutMs || 90000;
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch("http://127.0.0.1:" + port + "/api/health")
        .then((res) => {
          if (res.ok) resolve();
          else retry();
        })
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("Server API tidak merespons dalam waktu yang wajar"));
        return;
      }
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

function startApiServer() {
  const port = 4000;
  apiProcess = spawn(process.execPath, [apiServerPath], {
    env: Object.assign({}, process.env, {
      NODE_ENV: "production",
      PORT: String(port),
      DB_FILE_PATH: dbFilePath,
      SYSTEM_DB_FILE_PATH: systemDbFilePath,
      COMPANY_DATA_ROOT: companyDataRoot,
      STATIC_WEB_DIR: webDistPath,
      SESSION_SECRET: getOrCreateSessionSecret(),
      ELECTRON_RUN_AS_NODE: "1",
    }),
    stdio: "pipe",
  });

  // SEBELUM ini, output proses api HANYA ditulis ke process.stdout/stderr
  // milik main process -- lenyap tanpa jejak di app packaged (tidak ada
  // console window). Ditemukan via laporan klien nyata ("putih semua" ->
  // window gagal connect ke 127.0.0.1:4000, ERR_CONNECTION_REFUSED di
  // renderer-errors.log -- artinya proses api ini sendiri gagal start atau
  // crash, tapi TIDAK ADA cara utk tahu kenapa tanpa output asli proses
  // ini). Ditulis ke diagnostic.log (sama dgn log renderer) spy keduanya
  // kebaca kronologis dlm satu file.
  apiProcess.stdout.on("data", (chunk) => {
    process.stdout.write("[api] " + chunk);
    logDiag("[api:stdout] " + chunk.toString().trim());
  });
  apiProcess.stderr.on("data", (chunk) => {
    process.stderr.write("[api] " + chunk);
    logDiag("[api:stderr] " + chunk.toString().trim());
  });
  apiProcess.on("error", (err) => {
    logDiag("[api:spawn-error] " + (err && err.stack ? err.stack : String(err)));
  });
  apiProcess.on("exit", (code, signal) => {
    logDiag("[api:exit] code=" + code + " signal=" + signal);
    if (code !== 0 && code !== null) {
      console.error("Server API keluar dgn kode " + code);
    }
  });

  return port;
}

/** Backup terjadwal -- logika ada di backup.js (dapat diuji): menyalin database
 * master, system, dan SEMUA companies/<slug>/company.db ke folder `backups/`
 * dgn timestamp, retensi 30 hari (backup terbaru tiap database selalu
 * dipertahankan). Dipanggil sekali setelah server siap & berkala tiap 6 jam. */
function runBackup() {
  try {
    const result = backup.runBackup(userDataDir);
    if (result.copied.length) logDiag("[backup] disalin: " + result.copied.join(", "));
  } catch (err) {
    logDiag("[backup:gagal] " + (err && err.message ? err.message : String(err)));
  }
}

async function createWindow() {
  const port = startApiServer();
  try {
    await waitForServerReady(port);
  } catch (err) {
    console.error(err);
    logDiag("[wait-for-server-ready:timeout] " + (err && err.message ? err.message : String(err)));
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    autoHideMenuBar: true,
    // `show: false` + tunggu "ready-to-show" (di bawah) -- window versi
    // sebelumnya langsung muncul (show default true) SEBELUM contentnya
    // sempat ter-paint, jadi kalau proses render lambat/gagal, yg terlihat
    // klien adalah window kosong/putih yg SUDAH terbuka (persis gejala yg
    // dilaporkan). Dgn ini window baru ditampilkan setelah Chromium benar2
    // selesai paint pertama -- fallback timer di bawah TETAP menampilkannya
    // stlh 8 detik walopun "ready-to-show" tak pernah terpicu, supaya klien
    // tidak melihat APLIKASI TIDAK TERBUKA SAMA SEKALI (lebih membingungkan
    // drpd window putih yg setidaknya menunjukkan app jalan).
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let shown = false;
  const showWindowOnce = () => {
    if (shown || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
  };
  mainWindow.once("ready-to-show", showWindowOnce);
  setTimeout(showWindowOnce, 8000);

  // Catat ke diagnostic.log (logDiag, didefinisikan di atas dekat
  // userDataDir -- file yg SAMA dgn log stdout/stderr proses api) kalau
  // window gagal load atau renderer-nya crash/mati -- TANPA ini, gejala
  // "layar putih kosong" di komputer klien tidak bisa didiagnosis sama
  // sekali dari jarak jauh. Satu file gabungan (bukan file terpisah spt
  // sebelumnya) supaya urutan "server mati duluan" vs "renderer gagal load
  // belakangan" kebaca jelas -- TERBUKTI penting: laporan klien nyata
  // ("putih semua") ternyata root cause-nya di proses api (lihat log
  // apiProcess di atas), BUKAN di renderer/GPU seperti dugaan awal --
  // did-fail-load code=-102 ERR_CONNECTION_REFUSED di sinilah yg pertama
  // kali mengarahkan ke situ.
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logDiag("[renderer:did-fail-load] code=" + errorCode + " desc=" + errorDescription + " url=" + validatedURL);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logDiag("[renderer:render-process-gone] reason=" + details.reason);
  });

  const startUrl = process.env.ELECTRON_START_URL || "http://127.0.0.1:" + port;
  await mainWindow.loadURL(startUrl);
}

app.whenReady().then(() => {
  // Backup pertama dijalankan SETELAH server siap (upgrade company.db otomatis
  // selesai dulu), supaya salinan tidak menangkap database di tengah migrasi.
  createWindow().then(runBackup, runBackup);
  setInterval(runBackup, 6 * 60 * 60 * 1000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (apiProcess) apiProcess.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (apiProcess) apiProcess.kill();
});
