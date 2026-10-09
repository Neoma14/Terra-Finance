import { createCompanyDb } from "../index.js";
import {
  approveInterBranch,
  approveInterBranchReversal,
  cancelInterBranch,
  proposeInterBranch,
  requestInterBranchReversal,
  type InterBranchPrincipal,
  type ProposeInput,
} from "../inter-branch-service.js";
import { makePrincipal } from "./inter-branch-test-helpers.js";

/**
 * Proses ANAK untuk uji balapan LINTAS-PROSES (inter-branch-race.test.ts): setiap proses punya koneksi dan antrean
 * tulis sendiri, sehingga hanya kunci SQLite + klaim bersyarat di database yang menyerialkan mereka -- keadaan yang
 * sama dengan dua proses aplikasi yang membuka satu company.db. Dijalankan lewat `node --import tsx`.
 */

interface Job {
  file: string;
  action: "approve" | "cancel" | "propose" | "request-reversal" | "approve-reversal";
  txId?: string;
  startAt: number;
  principal: { userId: string; role: "OWNER" | "ADMIN" | "ACCOUNTANT" | "STAFF" | "VIEWER"; branches: "ALL" | string[] };
  propose?: ProposeInput;
}

const job: Job = JSON.parse(process.argv[2]);
const principal: InterBranchPrincipal = makePrincipal(job.principal);
const db = createCompanyDb(job.file);

function waitUntil(ts: number): void {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < ts) Atomics.wait(gate, 0, 0, 1);
}

async function run(): Promise<unknown> {
  switch (job.action) {
    case "approve":
      return approveInterBranch(db, principal, job.txId!);
    case "cancel":
      return cancelInterBranch(db, principal, job.txId!);
    case "request-reversal":
      return requestInterBranchReversal(db, principal, job.txId!, { reason: "Salah input nominal setoran" });
    case "approve-reversal":
      return approveInterBranchReversal(db, principal, job.txId!);
    case "propose":
      return proposeInterBranch(db, principal, job.propose!);
  }
}

waitUntil(job.startAt);
const started = Date.now();
run()
  .then(
    (result) => ({ outcome: "ok", result }),
    (e: Error & { code?: string }) => ({ outcome: e.constructor.name, code: e.code, message: e.message }),
  )
  .then(async (res) => {
    await db.destroy();
    process.stdout.write(`RESULT ${JSON.stringify({ ...res, ms: Date.now() - started })}\n`);
  });
