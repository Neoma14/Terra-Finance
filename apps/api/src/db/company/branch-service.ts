import crypto from "node:crypto";
import type { Knex } from "knex";
import { appendCompanyAudit, type ActorContext } from "./company-audit.js";
import { assertNoPendingInterBranch, cancelPendingInterBranchForBranch, countPendingInterBranchForBranch } from "./inter-branch-lifecycle.js";

/**
 * Master cabang (Multi-Branch Phase 1) di dalam company.db.
 *
 * Satu company.db = satu perusahaan, jadi tidak ada `company_id`. COA tetap
 * satu; cabang hanya dimensi di header jurnal. Service ini memegang
 * lifecycle ACTIVE / INACTIVE / CLOSED, soft delete cabang yang belum
 * pernah dipakai, serta aturan "jurnal dari asal X boleh masuk cabang
 * berstatus Y" (matriks status x asal).
 */

export const BRANCH_STATUSES = ["ACTIVE", "INACTIVE", "CLOSED"] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

/** Asal jurnal. Ditetapkan SERVER -- tidak pernah dibaca dari request. */
export const JOURNAL_ORIGINS = ["manual", "import", "opening_balance", "system", "inter_branch", "head_office_effect"] as const;
export type JournalOrigin = (typeof JOURNAL_ORIGINS)[number];

/** Asal yang didukung (head_office_effect belum; inter_branch hanya lewat prosedur Inter-Branch, lihat journal-service). */
export const SUPPORTED_JOURNAL_ORIGINS: readonly JournalOrigin[] = ["manual", "import", "opening_balance", "system", "inter_branch"];

/** Proses sistem yang sah -- daftar TERTUTUP di kode, bukan flag bebas. */
export const REGISTERED_SYSTEM_PROCESSES = ["branch_closure_settlement", "period_closing", "system_adjustment"] as const;
export type SystemProcess = (typeof REGISTERED_SYSTEM_PROCESSES)[number];

export const BRANCH_AUDIT_ACTIONS = {
  CREATED: "branch.created",
  UPDATED: "branch.updated",
  ACTIVATED: "branch.activated",
  DEACTIVATED: "branch.deactivated",
  CLOSED: "branch.closed",
  REOPENED: "branch.reopened",
  DELETED: "branch.deleted",
  NONACTIVE_POSTING: "branch.nonactive_posting",
  MULTI_BRANCH_CHANGED: "company_setting.multi_branch_enabled",
} as const;

export class BranchNotFoundError extends Error {
  readonly code = "BRANCH_NOT_FOUND" as const;
}
export class BranchCodeExistsError extends Error {
  readonly code = "BRANCH_CODE_EXISTS" as const;
}
export class BranchInvalidInputError extends Error {
  readonly code = "BRANCH_INVALID_INPUT" as const;
}
export class BranchInvalidTransitionError extends Error {
  readonly code = "BRANCH_INVALID_TRANSITION" as const;
}
export class BranchHeadOfficeProtectedError extends Error {
  readonly code = "BRANCH_HEAD_OFFICE_PROTECTED" as const;
}
export class BranchInUseError extends Error {
  readonly code = "BRANCH_IN_USE" as const;
}
export class MultiBranchDisabledError extends Error {
  readonly code = "MULTI_BRANCH_DISABLED" as const;
}
export interface ClosureBlocker {
  code: string;
  message: string;
  count: number;
}
export class BranchClosureBlockedError extends Error {
  readonly code = "BRANCH_CLOSURE_BLOCKED" as const;
  constructor(
    message: string,
    public readonly blockers: ClosureBlocker[],
  ) {
    super(message);
  }
}
export class BranchNotOperationalError extends Error {
  readonly code = "BRANCH_NOT_OPERATIONAL" as const;
  constructor(
    message: string,
    public readonly branchId: string,
    public readonly status: BranchStatus,
    public readonly origin: JournalOrigin,
  ) {
    super(message);
  }
}
export class JournalOriginNotSupportedError extends Error {
  readonly code = "JOURNAL_ORIGIN_NOT_SUPPORTED" as const;
}

export interface BranchRow {
  id: string;
  code: string;
  name: string;
  status: BranchStatus;
  isHeadOffice: boolean;
  address: string | null;
  phone: string | null;
  sortOrder: number;
  openedAt: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeReason: string | null;
  reopenedAt: string | null;
  reopenedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

const COLUMNS = [
  "id",
  "code",
  "name",
  "status",
  "is_head_office as isHeadOffice",
  "address",
  "phone",
  "sort_order as sortOrder",
  "opened_at as openedAt",
  "closed_at as closedAt",
  "closed_by as closedBy",
  "close_reason as closeReason",
  "reopened_at as reopenedAt",
  "reopened_by as reopenedBy",
  "created_by as createdBy",
  "created_at as createdAt",
  "updated_at as updatedAt",
  "deleted_at as deletedAt",
];

function toRow(raw: any): BranchRow {
  return { ...raw, isHeadOffice: Boolean(raw.isHeadOffice), sortOrder: Number(raw.sortOrder) };
}

export async function getBranch(db: Knex, id: string, opts: { includeDeleted?: boolean } = {}): Promise<BranchRow | undefined> {
  let q = db("branches").select(COLUMNS).where({ id });
  if (!opts.includeDeleted) q = q.whereNull("deleted_at");
  const row = await q.first();
  return row ? toRow(row) : undefined;
}

export async function requireBranch(db: Knex, id: string): Promise<BranchRow> {
  const row = await getBranch(db, id);
  if (!row) throw new BranchNotFoundError(`Cabang dengan id "${id}" tidak ditemukan.`);
  return row;
}

export async function getHeadOfficeBranch(db: Knex): Promise<BranchRow> {
  const row = await db("branches").select(COLUMNS).where({ is_head_office: true }).first();
  if (!row) throw new BranchNotFoundError("Kantor Pusat tidak ditemukan pada perusahaan ini.");
  return toRow(row);
}

export async function listBranches(db: Knex, opts: { includeDeleted?: boolean } = {}): Promise<BranchRow[]> {
  let q = db("branches").select(COLUMNS).orderBy([{ column: "sort_order" }, { column: "code" }]);
  if (!opts.includeDeleted) q = q.whereNull("deleted_at");
  return (await q).map(toRow);
}

export async function isMultiBranchEnabled(db: Knex): Promise<boolean> {
  const row = await db("company_profile").select("multi_branch_enabled as enabled").first();
  return Boolean(row?.enabled);
}

export async function setMultiBranchEnabled(db: Knex, enabled: boolean, actor: ActorContext): Promise<void> {
  const current = await isMultiBranchEnabled(db);
  if (current === enabled) return;
  await db.transaction(async (trx) => {
    // K-3: tidak boleh dimatikan selama ada transaksi antar-cabang yang menunggu (kedaluwarsa ditandai dulu).
    if (!enabled) await assertNoPendingInterBranch(trx);
    await trx("company_profile").update({ multi_branch_enabled: enabled ? 1 : 0 });
    await appendCompanyAudit(trx, {
      actor,
      action: BRANCH_AUDIT_ACTIONS.MULTI_BRANCH_CHANGED,
      entityType: "company_profile",
      entityId: "company_profile",
      before: { multiBranchEnabled: current },
      after: { multiBranchEnabled: enabled },
    });
  });
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;

function normalizeCode(raw: string): string {
  const code = (raw ?? "").trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) {
    throw new BranchInvalidInputError("Kode cabang harus 1-30 karakter (huruf, angka, titik, garis bawah, atau tanda hubung) dan diawali huruf/angka.");
  }
  return code;
}

function normalizeName(raw: string): string {
  const name = (raw ?? "").trim();
  if (name.length < 1 || name.length > 120) throw new BranchInvalidInputError("Nama cabang wajib diisi (maksimal 120 karakter).");
  return name;
}

function normalizeOptionalText(raw: string | null | undefined, label: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > max) throw new BranchInvalidInputError(`${label} maksimal ${max} karakter.`);
  return v;
}

export interface CreateBranchInput {
  code: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  /** Cabang boleh dibuat langsung INACTIVE (disiapkan, belum beroperasi). */
  status?: "ACTIVE" | "INACTIVE";
  openedAt?: string | null;
}

export async function createBranch(db: Knex, input: CreateBranchInput, actor: ActorContext): Promise<{ id: string }> {
  if (!(await isMultiBranchEnabled(db))) {
    throw new MultiBranchDisabledError("Fitur multi-cabang belum diaktifkan untuk perusahaan ini. Aktifkan terlebih dahulu (hanya OWNER).");
  }
  const code = normalizeCode(input.code);
  const name = normalizeName(input.name);
  const address = normalizeOptionalText(input.address, "Alamat", 255);
  const phone = normalizeOptionalText(input.phone, "Telepon", 50);
  const status = input.status ?? "ACTIVE";
  if (status !== "ACTIVE" && status !== "INACTIVE") {
    throw new BranchInvalidInputError("Cabang baru hanya boleh dibuat sebagai ACTIVE atau INACTIVE.");
  }
  const id = crypto.randomUUID();

  await db.transaction(async (trx) => {
    const dup = await trx("branches").where({ code }).first();
    if (dup) throw new BranchCodeExistsError(`Kode cabang "${code}" sudah dipakai (kode tetap dicadangkan walau cabang dihapus).`);
    const maxRow = await trx("branches").max({ m: "sort_order" }).first();
    await trx("branches").insert({
      id,
      code,
      name,
      status,
      is_head_office: false,
      address,
      phone,
      sort_order: Number((maxRow as any)?.m ?? 0) + 1,
      opened_at: input.openedAt ?? null,
      created_by: actor.actorId ?? null,
    });
    await appendCompanyAudit(trx, {
      actor,
      action: BRANCH_AUDIT_ACTIONS.CREATED,
      entityType: "branch",
      entityId: id,
      branchId: id,
      after: { code, name, status },
    });
  });
  return { id };
}

export interface UpdateBranchInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  sortOrder?: number;
}

export async function updateBranch(db: Knex, id: string, input: UpdateBranchInput, actor: ActorContext): Promise<void> {
  const existing = await requireBranch(db, id);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) patch.name = normalizeName(input.name);
  if (input.address !== undefined) patch.address = normalizeOptionalText(input.address, "Alamat", 255);
  if (input.phone !== undefined) patch.phone = normalizeOptionalText(input.phone, "Telepon", 50);
  if (input.sortOrder !== undefined) {
    if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0 || input.sortOrder > 9999) {
      throw new BranchInvalidInputError("Urutan tampil harus bilangan bulat 0-9999.");
    }
    patch.sort_order = input.sortOrder;
  }
  await db.transaction(async (trx) => {
    await trx("branches").where({ id }).update(patch);
    await appendCompanyAudit(trx, {
      actor,
      action: BRANCH_AUDIT_ACTIONS.UPDATED,
      entityType: "branch",
      entityId: id,
      branchId: id,
      before: { name: existing.name, address: existing.address, phone: existing.phone, sortOrder: existing.sortOrder },
      after: input,
    });
  });
}

export interface BranchClosurePreview {
  branchId: string;
  blockers: ClosureBlocker[];
  warnings: Array<{ code: string; message: string; count: number; accounts?: Array<{ code: string; name: string; balance: number }> }>;
}

/** Saldo akun neraca (non-flow) per cabang -- dipakai sebagai peringatan sebelum cabang ditutup. */
async function nonZeroBalanceSummary(db: Knex, branchId: string): Promise<Array<{ code: string; name: string; balance: number }>> {
  const rows = await db("journal_entry_lines as jel")
    .join("journal_entries as je", "je.id", "jel.journal_entry_id")
    .join("accounts as a", "a.id", "jel.account_id")
    .join("account_types as t", "t.id", "a.account_type_id")
    .where("je.branch_id", branchId)
    .whereIn("je.status", ["POSTED", "REVERSED"])
    .whereNotIn("t.code", ["REVENUE", "EXPENSE", "COGS", "OTHER_INCOME", "OTHER_EXPENSE"])
    .groupBy("a.id")
    .select(
      "a.code as code",
      "a.name as name",
      "a.normal_balance as normalBalance",
      db.raw("COALESCE(SUM(CAST(ROUND(jel.debit * 100) AS INTEGER)), 0) as d"),
      db.raw("COALESCE(SUM(CAST(ROUND(jel.credit * 100) AS INTEGER)), 0) as c"),
    );
  return (rows as any[])
    .map((r) => {
      const signed = r.normalBalance === "debit" ? Number(r.d) - Number(r.c) : Number(r.c) - Number(r.d);
      return { code: r.code as string, name: r.name as string, balance: signed / 100 };
    })
    .filter((r) => r.balance !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function previewBranchClosure(db: Knex, id: string): Promise<BranchClosurePreview> {
  await requireBranch(db, id);
  const blockers: ClosureBlocker[] = [];
  const warnings: BranchClosurePreview["warnings"] = [];

  const drafts = await db("journal_entries").where({ branch_id: id, status: "DRAFT" }).count({ c: "*" }).first();
  const draftCount = Number((drafts as any)?.c ?? 0);
  if (draftCount > 0) {
    blockers.push({ code: "DRAFT_JOURNALS", message: `Masih ada ${draftCount} jurnal DRAFT di cabang ini. Posting atau hapus terlebih dahulu.`, count: draftCount });
  }

  const pendingInterBranch = await countPendingInterBranchForBranch(db, id);
  if (pendingInterBranch > 0) {
    warnings.push({
      code: "PENDING_INTER_BRANCH",
      message: `Ada ${pendingInterBranch} transaksi/pembalikan antar-cabang yang menunggu dan akan dibatalkan otomatis bila cabang ini dinonaktifkan atau ditutup.`,
      count: pendingInterBranch,
    });
  }

  const balances = await nonZeroBalanceSummary(db, id);
  if (balances.length > 0) {
    warnings.push({
      code: "NON_ZERO_BALANCES",
      message: `Cabang masih memiliki saldo pada ${balances.length} akun neraca. Pastikan sudah diselesaikan sebelum ditutup.`,
      count: balances.length,
      accounts: balances.slice(0, 20),
    });
  }
  return { branchId: id, blockers, warnings };
}

const ALLOWED_TRANSITIONS: Record<BranchStatus, BranchStatus[]> = {
  ACTIVE: ["INACTIVE", "CLOSED"],
  INACTIVE: ["ACTIVE", "CLOSED"],
  CLOSED: ["ACTIVE"],
};

export interface ChangeBranchStatusInput {
  to: BranchStatus;
  reason?: string | null;
}

export async function changeBranchStatus(db: Knex, id: string, input: ChangeBranchStatusInput, actor: ActorContext): Promise<void> {
  if (!BRANCH_STATUSES.includes(input.to)) throw new BranchInvalidInputError("Status cabang tidak valid.");
  const existing = await requireBranch(db, id);
  if (existing.isHeadOffice) {
    throw new BranchHeadOfficeProtectedError("Kantor Pusat tidak boleh dinonaktifkan atau ditutup.");
  }
  if (existing.status === input.to) {
    throw new BranchInvalidTransitionError(`Cabang sudah berstatus ${input.to}.`);
  }
  if (!ALLOWED_TRANSITIONS[existing.status].includes(input.to)) {
    throw new BranchInvalidTransitionError(
      existing.status === "CLOSED"
        ? "Cabang yang sudah ditutup hanya dapat dibuka kembali menjadi ACTIVE."
        : `Perubahan status ${existing.status} -> ${input.to} tidak diizinkan.`,
    );
  }
  const reason = (input.reason ?? "").trim();
  if ((input.to === "CLOSED" || existing.status === "CLOSED") && reason.length < 3) {
    throw new BranchInvalidInputError(input.to === "CLOSED" ? "Alasan penutupan cabang wajib diisi." : "Alasan membuka kembali cabang wajib diisi.");
  }

  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    if (input.to === "CLOSED") {
      const preview = await previewBranchClosure(trx, id);
      if (preview.blockers.length > 0) {
        throw new BranchClosureBlockedError("Cabang belum dapat ditutup: " + preview.blockers.map((b) => b.message).join(" "), preview.blockers);
      }
    }
    const patch: Record<string, unknown> = { status: input.to, updated_at: now };
    let action: string = BRANCH_AUDIT_ACTIONS.UPDATED;
    if (input.to === "CLOSED") {
      patch.closed_at = now;
      patch.closed_by = actor.actorId ?? null;
      patch.close_reason = reason;
      action = BRANCH_AUDIT_ACTIONS.CLOSED;
    } else if (existing.status === "CLOSED") {
      patch.reopened_at = now;
      patch.reopened_by = actor.actorId ?? null;
      action = BRANCH_AUDIT_ACTIONS.REOPENED;
    } else {
      action = input.to === "ACTIVE" ? BRANCH_AUDIT_ACTIONS.ACTIVATED : BRANCH_AUDIT_ACTIONS.DEACTIVATED;
    }
    await trx("branches").where({ id }).update(patch);
    if (input.to === "INACTIVE" || input.to === "CLOSED") {
      await cancelPendingInterBranchForBranch(trx, id, actor, `Cabang "${existing.name}" menjadi ${input.to}${reason ? `: ${reason}` : ""}`);
    }
    await appendCompanyAudit(trx, {
      actor,
      action,
      entityType: "branch",
      entityId: id,
      branchId: id,
      before: { status: existing.status },
      after: { status: input.to },
      reason: reason || null,
    });
  });
}

export interface BranchUsage {
  journals: number;
  counterpartAccounts: number;
}

export async function getBranchUsage(db: Knex, id: string): Promise<BranchUsage> {
  const j = await db("journal_entries").where({ branch_id: id }).count({ c: "*" }).first();
  const a = await db("accounts").where({ counterpart_branch_id: id }).count({ c: "*" }).first();
  return { journals: Number((j as any)?.c ?? 0), counterpartAccounts: Number((a as any)?.c ?? 0) };
}

/**
 * Soft delete HANYA untuk cabang yang belum pernah dipakai (nol jurnal, nol
 * akun yang menunjuknya sebagai cabang lawan, nol akses user aktif --
 * `activeAccessCount` diberikan pemanggil karena akses user ada di System DB).
 * Kode cabang tetap dicadangkan. Tidak ada DELETE fisik (trigger menolaknya).
 */
export async function softDeleteUnusedBranch(db: Knex, id: string, activeAccessCount: number, actor: ActorContext): Promise<void> {
  const existing = await requireBranch(db, id);
  if (existing.isHeadOffice) throw new BranchHeadOfficeProtectedError("Kantor Pusat tidak boleh dihapus.");
  const usage = await getBranchUsage(db, id);
  if (usage.journals > 0 || usage.counterpartAccounts > 0 || activeAccessCount > 0) {
    throw new BranchInUseError(
      "Cabang ini sudah pernah dipakai (jurnal, akun antar-cabang, atau akses user) dan tidak dapat dihapus. Gunakan status INACTIVE atau CLOSED.",
    );
  }
  const now = new Date().toISOString();
  await db.transaction(async (trx) => {
    await trx("branches").where({ id }).update({ deleted_at: now, deleted_by: actor.actorId ?? null, updated_at: now });
    await appendCompanyAudit(trx, {
      actor,
      action: BRANCH_AUDIT_ACTIONS.DELETED,
      entityType: "branch",
      entityId: id,
      branchId: id,
      before: { code: existing.code, name: existing.name, status: existing.status },
    });
  });
}

/**
 * Matriks status cabang x asal jurnal (Phase 1-2):
 *   manual / import / opening_balance / inter_branch -> hanya cabang ACTIVE
 *   system -> status apa pun (tidak terhapus), pengecualian pada cabang
 *             non-ACTIVE ditandai `exception = true` agar diaudit pemanggil
 *   head_office_effect -> belum didukung
 */
export async function assertBranchAcceptsOrigin(
  db: Knex,
  branchId: string,
  origin: JournalOrigin,
): Promise<{ branch: BranchRow; exception: boolean }> {
  if (!SUPPORTED_JOURNAL_ORIGINS.includes(origin)) {
    throw new JournalOriginNotSupportedError(`Asal jurnal "${origin}" belum didukung.`);
  }
  const branch = await requireBranch(db, branchId);
  if (branch.status === "ACTIVE") return { branch, exception: false };
  if (origin === "system") return { branch, exception: true };
  throw new BranchNotOperationalError(
    branch.status === "CLOSED"
      ? `Cabang "${branch.name}" sudah ditutup: tidak dapat menerima transaksi baru.`
      : `Cabang "${branch.name}" sedang tidak aktif: tidak dapat menerima transaksi baru.`,
    branch.id,
    branch.status,
    origin,
  );
}
