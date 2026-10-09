import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../middleware/auth-guard.js";
import { requireCompanyAccess } from "../../middleware/company-access-guard.js";
import { hasPermission } from "../../db/system/rbac.js";
import { openCompanyDbForSlug } from "../../db/company/company-resolver.js";

/**
 * Pencarian global (Ctrl+K). Alur keamanan sama dengan route lain:
 * autentikasi -> akses perusahaan -> permission. Permission dicek PER
 * KATEGORI hasil: transaksi hanya untuk peran dengan `journal.read`, akun
 * hanya untuk `account.read`. Peran tanpa izin mendapat daftar kosong untuk
 * kategori itu (bukan error) sehingga pencarian bukan jalur bypass.
 */

const MAX_RESULTS = 8;
const MAX_QUERY_LENGTH = 100;

/** Karakter escape LIKE = "!" (backslash dimakan oleh knex.raw). */
function escapeLike(term: string): string {
  return term.replace(/[!%_]/g, (c) => `!${c}`);
}

/** "Rp 1.500.000" / "1,500,000" / "1500000" -> 1500000; selain itu null. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/rp/gi, "").replace(/[\s.,]/g, "");
  if (!/^\d{3,15}$/.test(cleaned)) return null;
  return Number(cleaned);
}

export async function companySearchRoutes(app: FastifyInstance) {
  app.get<{ Params: { companySlug: string }; Querystring: { q?: string } }>(
    "/api/company-db/:companySlug/search",
    { preHandler: [requireAuth, requireCompanyAccess] },
    async (request, reply) => {
      const q = (request.query.q ?? "").trim().slice(0, MAX_QUERY_LENGTH);
      if (q.length < 2) return reply.send({ journals: [], accounts: [] });

      const role = request.companyAccess!.role;
      const canJournals = hasPermission(role, "journal.read");
      const canAccounts = hasPermission(role, "account.read");
      if (!canJournals && !canAccounts) return reply.send({ journals: [], accounts: [] });

      const like = `%${escapeLike(q.toLowerCase())}%`;
      const amount = parseAmount(q);
      const db = openCompanyDbForSlug(request.params.companySlug);
      try {
        // Phase 5: akun LIMITED hanya mencari jurnal pada cabang dalam aksesnya (server menentukan, bukan klien);
        // akun ALL-scope tidak berubah. Daftar kosong => tidak ada jurnal yang cocok (fail-closed).
        const access = request.companyAccess!;
        const branchFilter = access.branchScope === "LIMITED" ? (access.allowedBranchIds ?? []) : null;
        let journals: unknown[] = [];
        if (canJournals) {
          journals = await db("journal_entries as je")
            .modify((qb) => {
              if (branchFilter) qb.whereIn("je.branch_id", branchFilter.length > 0 ? branchFilter : ["__none__"]);
            })
            .where((b) => {
              b.whereRaw("lower(je.reference_no) like ? escape '!'", [like])
                .orWhereRaw("lower(coalesce(je.description, '')) like ? escape '!'", [like])
                .orWhereRaw("cast(je.entry_date as text) like ? escape '!'", [like])
                .orWhereRaw(
                  `exists (select 1 from journal_entry_lines l join accounts a on a.id = l.account_id
                           where l.journal_entry_id = je.id
                             and (lower(a.code) like ? escape '!' or lower(a.name) like ? escape '!' or lower(coalesce(l.memo, '')) like ? escape '!'))`,
                  [like, like, like],
                );
              if (amount !== null) {
                b.orWhereRaw("(select coalesce(sum(l.debit), 0) from journal_entry_lines l where l.journal_entry_id = je.id) = ?", [amount]);
              }
            })
            .select(
              "je.id",
              "je.reference_no as referenceNo",
              "je.description",
              "je.entry_date as entryDate",
              "je.status",
              db.raw("(select coalesce(sum(l.debit), 0) from journal_entry_lines l where l.journal_entry_id = je.id) as total"),
            )
            .orderBy("je.entry_date", "desc")
            .limit(MAX_RESULTS);
        }

        let accounts: unknown[] = [];
        if (canAccounts) {
          accounts = await db("accounts")
            .whereRaw("lower(code) like ? escape '!'", [like])
            .orWhereRaw("lower(name) like ? escape '!'", [like])
            .select("id", "code", "name", "is_active as isActive", "is_locked as isLocked")
            .orderBy("code")
            .limit(MAX_RESULTS);
        }
        return reply.send({ journals, accounts });
      } finally {
        await db.destroy();
      }
    },
  );
}
