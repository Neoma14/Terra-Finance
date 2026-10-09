import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyInterBranchIntegrity } from "./inter-branch-integrity.js";
import { proposeInterBranch, type ProposeInput } from "./inter-branch-service.js";
import { cashAccounts, interBranchWorld, makePrincipal, type CashAccounts, type InterBranchWorld } from "./__fixtures__/inter-branch-test-helpers.js";

/**
 * Balapan LINTAS-PROSES NYATA: beberapa proses Node terpisah (masing-masing dengan koneksi dan antrean tulis sendiri)
 * menjalankan aksi yang sama atas satu company.db pada saat yang sama. Antrean tulis di dalam proses TIDAK menolong di
 * sini; yang menjaga hanya kunci SQLite + klaim bersyarat status + UNIQUE. Hasil yang dijamin: tidak pernah ada jurnal
 * ganda atau keadaan setengah jadi; pihak yang kalah mendapat penolakan bersih (409) atau SQLITE_BUSY yang dipetakan
 * menjadi InterBranchBusyError (tidak ada efek, aman diulang).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "__fixtures__", "inter-branch-race.worker.ts");
const API_ROOT = path.resolve(HERE, "..", "..", "..");

interface WorkerResult {
  outcome: string;
  code?: string;
  ms: number;
}

let w: InterBranchWorld;
let acc: CashAccounts;
let file: string;

beforeEach(async () => {
  w = await interBranchWorld();
  acc = await cashAccounts(w);
  file = (w.db.client.config.connection as { filename: string }).filename;
});
afterEach(async () => {
  await w.db.destroy();
});

function runWorker(job: Record<string, unknown>): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, JSON.stringify(job)], { cwd: API_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) return reject(new Error(`worker gagal (kode ${code}): ${err || out}`));
      resolve(JSON.parse(line.slice(7)) as WorkerResult);
    });
  });
}

/** Semua proses menunggu titik waktu yang sama, lalu mulai bersamaan. */
const race = (jobs: Array<Record<string, unknown>>, leadMs = 4000) => {
  const startAt = Date.now() + leadMs;
  return Promise.all(jobs.map((j) => runWorker({ file, startAt, ...j })));
};
const who = (userId: string, role: "OWNER" | "ACCOUNTANT" | "ADMIN", branches: "ALL" | string[]) => ({ userId, role, branches });
const journals = (id: string) => w.db("journal_entries").where({ inter_branch_transaction_id: id });
const tx = (id: string) => w.db("inter_branch_transactions").where({ id }).first();
const proposeBody = (): ProposeInput => ({
  type: "TRANSFER_KAS",
  fromBranchId: w.metro,
  toBranchId: w.bl,
  transactionDate: "2026-01-15",
  amount: 1_000_000,
  fromAccountId: acc.kas,
  toAccountSuggestedId: acc.bank,
  description: "Setoran kas lintas proses",
  idempotencyKey: crypto.randomUUID(),
});
const waiting = async () => (await proposeInterBranch(w.db, makePrincipal({ userId: "maker-1", role: "ACCOUNTANT", branches: [w.metro] }), proposeBody())).id;
const REJECTED_CLEANLY = ["InterBranchStateChangedError", "InterBranchBusyError"];

describe("balapan lintas-proses nyata (proses Node terpisah, satu file)", { timeout: 240_000 }, () => {
  it("tiga proses menyetujui transaksi yang sama: tepat satu menang, dua jurnal, yang kalah ditolak bersih; ulang oleh yang kalah tidak menggandakan", async () => {
    for (let round = 0; round < 3; round++) {
      const id = await waiting();
      const results = await race([1, 2, 3].map((n) => ({ action: "approve", txId: id, principal: who(`approver-${n}`, "ACCOUNTANT", [w.bl]) })));
      expect(results.filter((r) => r.outcome === "ok"), JSON.stringify(results)).toHaveLength(1);
      for (const r of results.filter((r) => r.outcome !== "ok")) expect(REJECTED_CLEANLY, JSON.stringify(r)).toContain(r.outcome);
      expect(await journals(id)).toHaveLength(2);
      expect((await tx(id)).status).toBe("COMPLETED");
      const retry = await race([{ action: "approve", txId: id, principal: who("approver-9", "ACCOUNTANT", [w.bl]) }], 1500);
      expect(retry[0].outcome).toBe("InterBranchStateChangedError");
      expect(await journals(id)).toHaveLength(2);
      expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    }
  });

  it("setujui vs batalkan dari proses berbeda: tepat satu hasil, jurnal konsisten dengan status", async () => {
    for (let round = 0; round < 3; round++) {
      const id = await waiting();
      const results = await race([
        { action: "approve", txId: id, principal: who("approver-1", "ACCOUNTANT", [w.bl]) },
        { action: "cancel", txId: id, principal: who("maker-1", "ACCOUNTANT", [w.metro]) },
      ]);
      expect(results.filter((r) => r.outcome === "ok").length, JSON.stringify(results)).toBe(1);
      const row = await tx(id);
      expect(["COMPLETED", "CANCELLED"]).toContain(row.status);
      expect((await journals(id)).length).toBe(row.status === "COMPLETED" ? 2 : 0);
      expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    }
  });

  it("dua permintaan dan dua persetujuan reversal dari proses berbeda: satu pembalikan, empat jurnal", async () => {
    const id = await waiting();
    await race([{ action: "approve", txId: id, principal: who("approver-1", "ACCOUNTANT", [w.bl]) }], 1500);
    const req = await race([
      { action: "request-reversal", txId: id, principal: who("maker-1", "ACCOUNTANT", [w.metro]) },
      { action: "request-reversal", txId: id, principal: who("owner-1", "OWNER", "ALL") },
    ]);
    expect(req.filter((r) => r.outcome === "ok"), JSON.stringify(req)).toHaveLength(1);
    const decide = await race([
      { action: "approve-reversal", txId: id, principal: who("approver-1", "ACCOUNTANT", [w.bl, w.metro]) },
      { action: "approve-reversal", txId: id, principal: who("approver-2", "ACCOUNTANT", [w.bl, w.metro]) },
    ]);
    expect(decide.filter((r) => r.outcome === "ok"), JSON.stringify(decide)).toHaveLength(1);
    expect(await journals(id)).toHaveLength(4);
    expect((await tx(id)).reversal_state).toBe("REVERSED");
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
  });

  it("pengajuan dengan kunci idempotensi sama dari tiga proses (yang kena SQLITE_BUSY mengulang): tepat satu transaksi", async () => {
    const body = proposeBody();
    const results = await race([1, 2, 3].map(() => ({ action: "propose", propose: body, principal: who("maker-1", "ACCOUNTANT", [w.metro]) })));
    for (const r of results) expect(["ok", "InterBranchBusyError"], JSON.stringify(r)).toContain(r.outcome);
    for (let i = 0; i < 2; i++) await race([{ action: "propose", propose: body, principal: who("maker-1", "ACCOUNTANT", [w.metro]) }], 1500);
    expect(await w.db("inter_branch_transactions")).toHaveLength(1);
  });

  it("idempotensi lintas-proses (diperkuat): 6 putaran x 4 proses (RACE_PROCS/RACE_ROUNDS untuk stres), kunci sama -> satu transaksi; pemanggil lain menerima replay pemenang yang SAMA (atau 503 aman-ulang), tanpa galat mentah, tanpa jurnal/persetujuan/audit ganda", async () => {
    const maker = who("maker-1", "ACCOUNTANT", [w.metro]);
    let replays = 0;
    const PROCS = Number(process.env.RACE_PROCS ?? 4), ROUNDS = Number(process.env.RACE_ROUNDS ?? 6); // stres: RACE_PROCS=10 RACE_ROUNDS=8
    for (let round = 0; round < ROUNDS; round++) {
      const body = proposeBody();
      const results = (await race(Array.from({ length: PROCS }, (_, i) => i).map(() => ({ action: "propose", propose: body, principal: maker })), 3000)) as Array<WorkerResult & { result?: { id: string; transactionNo: string; replayed: boolean } }>;
      for (const r of results) expect(["ok", "InterBranchBusyError"], `putaran ${round}: ${JSON.stringify(r)}`).toContain(r.outcome);
      const oks = results.filter((r) => r.outcome === "ok");
      expect(new Set(oks.map((r) => r.result!.id)).size, JSON.stringify(results)).toBeLessThanOrEqual(1);
      expect(oks.filter((r) => r.result!.replayed === false).length, JSON.stringify(results)).toBeLessThanOrEqual(1);
      replays += oks.filter((r) => r.result!.replayed).length;
      // pemanggil yang mendapat 503 mengulang dan harus menerima replay pemenang (bukan transaksi baru)
      const retry = (await race([{ action: "propose", propose: body, principal: maker }], 500)) as Array<WorkerResult & { result?: { id: string; replayed: boolean } }>;
      expect(retry[0].outcome, JSON.stringify(retry)).toBe("ok");
      expect(retry[0].result!.replayed).toBe(true);
      const rows = await w.db("inter_branch_transactions").where({ idempotency_key: body.idempotencyKey });
      expect(rows, `putaran ${round}`).toHaveLength(1);
      const id = rows[0].id as string;
      expect(retry[0].result!.id).toBe(id);
      for (const r of oks) expect(r.result!.id).toBe(id);
      expect(await w.db("inter_branch_approvals").where({ transaction_id: id })).toHaveLength(1);
      expect((await w.db("company_audit_log").where({ entity_id: id }).select("action")).map((a: { action: string }) => a.action).sort()).toEqual(["INTER_BRANCH_CREATED", "INTER_BRANCH_SUBMITTED"]);
      expect(await journals(id)).toHaveLength(0);
    }
    expect(await w.db("inter_branch_transactions")).toHaveLength(ROUNDS);
    expect(await verifyInterBranchIntegrity(w.db)).toEqual([]);
    console.log(`[idempotensi] replay diterima pada ${replays} pemanggil serempak dari ${ROUNDS * PROCS} percobaan`);
  }, 240_000);

  it("kunci idempotensi sama dari DUA PENGGUNA berbeda tidak saling me-replay (indeks UNIQUE per pengaju): dua transaksi", async () => {
    const body = proposeBody();
    const results = await race([
      { action: "propose", propose: body, principal: who("maker-1", "ACCOUNTANT", [w.metro]) },
      { action: "propose", propose: body, principal: who("maker-2", "ACCOUNTANT", [w.metro]) },
    ]) as Array<WorkerResult & { result?: { id: string; replayed: boolean } }>;
    const oks = results.filter((r) => r.outcome === "ok");
    for (const r of results) expect(["ok", "InterBranchBusyError"], JSON.stringify(r)).toContain(r.outcome);
    for (const r of oks) expect(r.result!.replayed).toBe(false);
    // yang sempat 503 mengulang: tetap membuat transaksi sendiri
    for (const user of ["maker-1", "maker-2"]) await race([{ action: "propose", propose: body, principal: who(user, "ACCOUNTANT", [w.metro]) }], 500);
    const rows = await w.db("inter_branch_transactions").where({ idempotency_key: body.idempotencyKey });
    expect(rows.map((r: { proposed_by: string }) => r.proposed_by).sort()).toEqual(["maker-1", "maker-2"]);
  }, 120_000);
});
