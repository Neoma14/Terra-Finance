import { Badge } from "../../../components/ui.js";
import {
  INTER_BRANCH_STATUS_LABEL,
  type InterBranchListItem,
  type InterBranchReversalState,
  type InterBranchStatus,
} from "../../../features/workspace/inter-branch-types.js";

const STATUS_TONE: Record<InterBranchStatus, "neutral" | "success" | "warning" | "danger"> = {
  WAITING_APPROVAL: "warning",
  COMPLETED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};

const REVERSAL_LABEL: Record<Exclude<InterBranchReversalState, "NOT_REVERSED">, string> = {
  REVERSAL_WAITING: "Pembalikan menunggu",
  REVERSED: "Sudah dibalik",
};

/**
 * Dua indikator terpisah (Spek §7): status TRANSAKSI (bisnis) dan status JURNAL (accounting event). "Selesai" tidak
 * sama dengan "diposting": keduanya berubah bersamaan saat persetujuan, tetapi ditampilkan terpisah agar tidak tertukar.
 */
export function InterBranchStatusBadges({ item }: { item: Pick<InterBranchListItem, "status" | "accountingEvent" | "reversalState"> }) {
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="ib-status">
      <Badge tone={STATUS_TONE[item.status]}>{INTER_BRANCH_STATUS_LABEL[item.status]}</Badge>
      <Badge tone={item.accountingEvent === "POSTED" ? "info" : "neutral"}>{item.accountingEvent === "POSTED" ? "Jurnal diposting" : "Belum ada jurnal"}</Badge>
      {item.reversalState !== "NOT_REVERSED" && <Badge tone={item.reversalState === "REVERSED" ? "danger" : "warning"}>{REVERSAL_LABEL[item.reversalState]}</Badge>}
    </div>
  );
}

export function formatDateTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
