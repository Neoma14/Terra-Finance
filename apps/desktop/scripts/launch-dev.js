// Dijalankan lewat "node scripts/launch-dev.js" (bukan langsung binary `electron`
// via package.json bin/cli.js) -- di environment ini paket "electron" ke-install
// tanpa cli.js (entah kenapa, tapi index.js yang resolve path binary tetap utuh),
// jadi shim bin `electron .` gagal dgn MODULE_NOT_FOUND. require("electron") dari
// dalam Node biasa (bukan proses Electron) mengembalikan path ke binary-nya.
const { spawn } = require("node:child_process");
const path = require("node:path");

const electronPath = require("electron");
const child = spawn(electronPath, ["."], {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
