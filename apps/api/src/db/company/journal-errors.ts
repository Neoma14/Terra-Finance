export class JournalInvalidDateError extends Error {
  readonly code = "JOURNAL_INVALID_DATE" as const;
}
