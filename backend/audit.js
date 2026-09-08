// Every sale void/refund, discount approval, stock adjustment, and controlled-item action gets
// an immutable, timestamped, user-attributed audit_log entry — the brief's Phase 1 domain-model
// requirement. One helper so every call site writes the same shape.
export function writeAuditLog(db, { entityType, entityId, action, userId, before, after }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO audit_log (entity_type, entity_id, action, user_id, before_json, after_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entityType,
    entityId ?? null,
    action,
    userId || 0,
    JSON.stringify(before ?? null),
    JSON.stringify(after ?? null),
    now
  );
}
