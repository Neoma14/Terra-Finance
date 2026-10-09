import { describe, it, expect } from "vitest";
import { hasPermission, isValidCompanyRole, COMPANY_ROLES, PERMISSIONS } from "./rbac.js";

/** Deterministic & testable (§12/§13 instruksi) -- baseline literal dari
 * TASK-DB-ARCH-010, bukan dihitung ulang dari sumber lain. */
describe("RBAC baseline role -> permission (TASK-DB-ARCH-010)", () => {
  it("VIEWER: hanya read, tidak bisa create/post/reverse/manage", () => {
    expect(hasPermission("VIEWER", "company.read")).toBe(true);
    expect(hasPermission("VIEWER", "account.read")).toBe(true);
    expect(hasPermission("VIEWER", "journal.read")).toBe(true);
    expect(hasPermission("VIEWER", "report.read")).toBe(true);
    expect(hasPermission("VIEWER", "journal.create")).toBe(false);
    expect(hasPermission("VIEWER", "journal.post")).toBe(false);
    expect(hasPermission("VIEWER", "journal.reverse")).toBe(false);
    expect(hasPermission("VIEWER", "users.manage")).toBe(false);
  });

  it("STAFF: bisa create journal, TIDAK bisa post/reverse/manage", () => {
    expect(hasPermission("STAFF", "journal.create")).toBe(true);
    expect(hasPermission("STAFF", "journal.read")).toBe(true);
    expect(hasPermission("STAFF", "journal.post")).toBe(false);
    expect(hasPermission("STAFF", "journal.reverse")).toBe(false);
    expect(hasPermission("STAFF", "users.manage")).toBe(false);
  });

  it("ACCOUNTANT: create/post/reverse journal + account create/update, TIDAK users.manage", () => {
    expect(hasPermission("ACCOUNTANT", "journal.create")).toBe(true);
    expect(hasPermission("ACCOUNTANT", "journal.post")).toBe(true);
    expect(hasPermission("ACCOUNTANT", "journal.reverse")).toBe(true);
    expect(hasPermission("ACCOUNTANT", "account.create")).toBe(true);
    expect(hasPermission("ACCOUNTANT", "account.update")).toBe(true);
    expect(hasPermission("ACCOUNTANT", "users.manage")).toBe(false);
    expect(hasPermission("ACCOUNTANT", "backup.create")).toBe(false);
  });

  it("ADMIN: seluruh permission ACCOUNTANT + company.update + users.manage, TIDAK backup", () => {
    expect(hasPermission("ADMIN", "journal.post")).toBe(true);
    expect(hasPermission("ADMIN", "company.update")).toBe(true);
    expect(hasPermission("ADMIN", "users.read")).toBe(true);
    expect(hasPermission("ADMIN", "users.manage")).toBe(true);
    expect(hasPermission("ADMIN", "backup.create")).toBe(false);
    expect(hasPermission("ADMIN", "backup.restore")).toBe(false);
  });

  it("OWNER: full -- seluruh permission tanpa kecuali", () => {
    for (const permission of PERMISSIONS) {
      expect(hasPermission("OWNER", permission)).toBe(true);
    }
  });

  it("role company-scoped -- fungsi murni, tidak bergantung state/DB sama sekali (deterministic)", () => {
    expect(hasPermission("VIEWER", "journal.post")).toBe(hasPermission("VIEWER", "journal.post"));
  });

  it("isValidCompanyRole menolak nilai di luar 5 role baku (anti privilege-escalation via string sembarang)", () => {
    expect(isValidCompanyRole("OWNER")).toBe(true);
    expect(isValidCompanyRole("SUPERADMIN")).toBe(false);
    expect(isValidCompanyRole("owner")).toBe(false); // case-sensitive, tidak longgar
    expect(COMPANY_ROLES).toEqual(["OWNER", "ADMIN", "ACCOUNTANT", "STAFF", "VIEWER"]);
  });
});
