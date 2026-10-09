import type { Knex } from "knex";
import type { SessionUser } from "../../modules/auth/session-service.js";

/**
 * Identity Bridge MINIMAL (TASK-DB-ARCH-010, Identity_Architecture_Proposal.md
 * Option A — "Legacy Authentication as Canonical Identity"). `masterDb.users`
 * TETAP satu-satunya sumber authentication -- bridge ini TIDAK membuat
 * login/password/session kedua, HANYA memastikan ada baris `system_users`
 * yang bisa dirujuk FK (`company_access.system_user_id`,
 * `companies_registry.created_by`) saat dibutuhkan.
 *
 * Mapping DETERMINISTIK: `system_users.id = legacyUser.id` (ID YANG SAMA
 * PERSIS) -- bukan tabel mapping terpisah, bukan email/fullName/role sbg
 * identity (dilarang eksplisit §6 instruksi). Verifiable: untuk
 * memastikan satu identity merujuk orang yang sama, cukup bandingkan id-nya
 * langsung.
 *
 * Lazy/progressive provisioning (§7): dipanggil HANYA saat dibutuhkan
 * (company access check, company creation) -- TIDAK dipanggil dari login
 * flow (`modules/auth/routes.ts` TIDAK diubah sama sekali).
 */

const UNUSED_SYSTEM_USERS_PASSWORD_PLACEHOLDER =
  "LEGACY_MANAGED_IDENTITY_NO_LOGIN"; // bukan hash asli -- system_users TIDAK PERNAH dipakai verifikasi password (lihat komentar modul ini)

export async function ensureSystemIdentity(systemDb: Knex, legacyUser: SessionUser): Promise<string> {
  const existing = await systemDb("system_users").where({ id: legacyUser.id }).first();
  if (existing) {
    // Sinkron ringan field tampilan (full_name/email bisa berubah di
    // legacy) -- TIDAK menyentuh password_hash/role (role company-scoped
    // tetap di `company_access`, bukan di sini).
    if (existing.email !== legacyUser.email || existing.full_name !== legacyUser.fullName) {
      await systemDb("system_users")
        .where({ id: legacyUser.id })
        .update({ email: legacyUser.email, full_name: legacyUser.fullName, updated_at: new Date().toISOString() });
    }
    return existing.id as string;
  }

  await systemDb("system_users").insert({
    id: legacyUser.id, // MAPPING: sama persis dgn masterDb.users.id
    email: legacyUser.email,
    password_hash: UNUSED_SYSTEM_USERS_PASSWORD_PLACEHOLDER,
    full_name: legacyUser.fullName,
    role: legacyUser.role,
    is_active: true,
  });
  return legacyUser.id;
}
