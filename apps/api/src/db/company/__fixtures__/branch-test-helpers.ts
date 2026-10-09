import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import knexLib, { type Knex } from "knex";
import baseKnexConfig from "../knexfile.js";
import { createCompanyDb } from "../index.js";
import { createBranch, setMultiBranchEnabled } from "../branch-service.js";
import type { ActorContext } from "../company-audit.js";

/** Helper tes Multi-Branch: company.db sementara (skema terbaru) dengan foreign_keys ON, seperti produksi. */

export const testActor: ActorContext = { actorType: "user", actorId: "test-user-1", actorLabel: "Test User" };

export async function freshCompanyDb(): Promise<Knex> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terra-branch-test-"));
  const file = path.join(dir, "company.db");
  const migrator = knexLib({ ...baseKnexConfig, connection: { filename: file } });
  try {
    await migrator.migrate.latest();
    // company_profile dibuat saat provisioning perusahaan; tes memerlukannya untuk flag multi-cabang.
    await migrator("company_profile").insert({ id: crypto.randomUUID(), name: "PT Tes" });
  } finally {
    await migrator.destroy();
  }
  return createCompanyDb(file);
}

export interface SeededAccounts {
  kasId: string;
  modalId: string;
  bebanId: string;
  hutangId: string;
  periodId: string;
}

export async function seedBasics(db: Knex): Promise<SeededAccounts> {
  const types = Object.fromEntries((await db("account_types").select("id", "code")).map((t: any) => [t.code, t.id]));
  const mk = async (code: string, name: string, type: string, normal: "debit" | "credit") => {
    const id = crypto.randomUUID();
    await db("accounts").insert({ id, code, name, account_type_id: types[type], normal_balance: normal });
    return id;
  };
  const kasId = await mk("1000", "Kas", "ASSET", "debit");
  const hutangId = await mk("2000", "Hutang Usaha", "LIABILITY", "credit");
  const modalId = await mk("3000", "Modal", "EQUITY", "credit");
  const bebanId = await mk("6000", "Beban", "EXPENSE", "debit");
  const periodId = crypto.randomUUID();
  await db("periods").insert({
    id: periodId,
    label: "Jan 2026",
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    period_type: "month",
    fiscal_year: 2026,
    status: "OPEN",
  });
  return { kasId, modalId, bebanId, hutangId, periodId };
}

/** Menyalakan multi-cabang dan membuat cabang ACTIVE; mengembalikan id-nya. */
export async function addBranch(db: Knex, code: string, name = code): Promise<string> {
  await setMultiBranchEnabled(db, true, testActor);
  const { id } = await createBranch(db, { code, name }, testActor);
  return id;
}

export async function headOfficeId(db: Knex): Promise<string> {
  return (await db("branches").where({ is_head_office: 1 }).first()).id;
}

let refCounter = 0;
export function nextRef(prefix = "JRN"): string {
  refCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${refCounter}`;
}
