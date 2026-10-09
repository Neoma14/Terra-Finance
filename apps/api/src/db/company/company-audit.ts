import crypto from "node:crypto";
import type { Knex } from "knex";

/**
 * Audit service reusable utk Company DB (TASK-DB-ARCH-006) -- menulis ke
 * `company_audit_log` (skema `C0012`, sudah ada sejak TASK-DB-ARCH-003,
 * TIDAK diubah di task ini). Pola & nama kolom mengikuti persis
 * `modules/audit/service.ts` (`recordAudit`, shared-DB lama) -- fungsi ini
 * BUKAN sistem audit baru, hanya versi Company DB dari pola yang sudah ada.
 *
 * SELALU dipanggil dgn `trx` (bukan `db` biasa) dari DALAM transaction yang
 * sama dgn perubahan accounting-nya (lihat journal-service.ts) -- kalau
 * insert audit ini gagal, `db.transaction()` otomatis rollback SELURUH
 * perubahan accounting di transaction yang sama (Knex: exception apa pun
 * di dalam callback transaction = rollback). Ini yang membuat audit
 * "wajib" tanpa perlu try/catch/console.warn apa pun -- kegagalan audit
 * SECARA STRUKTURAL turut menggagalkan operasi accounting-nya.
 */

export type ActorType = "user" | "administrator" | "system";

/**
 * Actor context -- WAJIB disediakan oleh caller (bukan parameter opsional),
 * mengikuti pola `modules/audit/service.ts` (`actorType`/`actorLabel` sudah
 * `notNullable` di schema, hanya `actorId` yang nullable, utk aksi
 * sistem/background TANPA user interaktif -- §9: representasi "system"
 * memakai `actorType: 'system'`, BUKAN fake user). Tidak ada default/global
 * `currentUser` di mana pun -- actor SELALU parameter eksplisit yang
 * dioper turun dari pemanggil tepercaya (service/route layer), tidak
 * pernah diambil dari payload request mentah (§21).
 */
export interface ActorContext {
  actorType: ActorType;
  actorId?: string | null;
  actorLabel: string;
}

export interface AppendCompanyAuditInput {
  actor: ActorContext;
  /** Identifier stabil, pola "domain.event" -- lihat JOURNAL_AUDIT_ACTIONS
   * di journal-service.ts. BUKAN pesan bebas (§10). */
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Cabang yang terkait peristiwa (Multi-Branch); null/kosong untuk peristiwa tingkat perusahaan. */
  branchId?: string | null;
}

/**
 * Satu-satunya cara menulis ke `company_audit_log`. HANYA INSERT -- tidak
 * ada (dan tidak boleh ada) fungsi update/delete audit di sini; append-only
 * sudah ditegakkan DI LEVEL DATABASE lewat trigger
 * `company_audit_log_no_update`/`_no_delete` (migration `C0012`, dibuat
 * TASK-DB-ARCH-003, tidak disentuh di sini) -- fungsi ini tidak menambah
 * proteksi baru, hanya memanfaatkan yang sudah ada.
 */
export async function appendCompanyAudit(trx: Knex, input: AppendCompanyAuditInput): Promise<void> {
  await trx("company_audit_log").insert({
    id: crypto.randomUUID(),
    actor_type: input.actor.actorType,
    actor_id: input.actor.actorId ?? null,
    actor_label: input.actor.actorLabel,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    before_json: input.before !== undefined ? JSON.stringify(input.before) : null,
    after_json: input.after !== undefined ? JSON.stringify(input.after) : null,
    reason: input.reason ?? null,
    branch_id: input.branchId ?? null,
    repair_mode: false,
  });
}
