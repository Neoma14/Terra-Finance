import { dbA, rec, note } from "./lib.mjs";
const db = dbA(); const r = db.prepare("select reference_no, entry_date, status, description from journal_entries where reference_no in ('IMP-E3','IMP-E2')").all(); db.close(); console.log(r);
const row = r.find((x) => x.reference_no === "IMP-E3");
rec("BUG-IMP-DATE", "import", "Import menerima tanggal tidak nyata '2026-02-30' sebagai VALID dan menyimpannya pada tanggal yang bergeser", !row, row ? `IMP-E3 tersimpan POSTED dengan entry_date=${String(row.entry_date).slice(0,10)} (seharusnya ditolak)` : "ditolak", "HIGH");
process.exit(0);
