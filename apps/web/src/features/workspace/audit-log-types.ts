export interface CompanyAuditLogEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  reason: string | null;
  createdAt: string;
}

export interface AuditLogListResult {
  entries: CompanyAuditLogEntry[];
  total: number;
}
