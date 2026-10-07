import { db } from './db.js';

/**
 * Atomically bump permit row_version. Returns new version or null if missing.
 * Call inside an open transaction when composing with other writes.
 */
export function bumpPermitRowVersion(permitId) {
  const info = db
    .prepare(
      `UPDATE permit_records
       SET row_version = COALESCE(row_version, 1) + 1,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(Number(permitId));
  if (!info.changes) return null;
  return db.prepare('SELECT row_version FROM permit_records WHERE id = ?').get(Number(permitId))
    ?.row_version;
}

/**
 * Compare-and-swap: succeed only when expected_row_version matches.
 * Returns { ok, permit } where permit is the row after successful claim
 * (version already bumped) or the current row on conflict/missing.
 */
export function claimPermitWrite(permitId, expectedRowVersion) {
  const id = Number(permitId);
  if (expectedRowVersion == null || expectedRowVersion === '' || Number.isNaN(Number(expectedRowVersion))) {
    return {
      ok: false,
      missingVersion: true,
      permit: db.prepare('SELECT * FROM permit_records WHERE id = ?').get(id) || null,
    };
  }
  const expected = Number(expectedRowVersion);
  const info = db
    .prepare(
      `UPDATE permit_records
       SET row_version = COALESCE(row_version, 1) + 1,
           updated_at = datetime('now')
       WHERE id = ? AND COALESCE(row_version, 1) = ?`
    )
    .run(id, expected);
  const permit = db.prepare('SELECT * FROM permit_records WHERE id = ?').get(id);
  if (!info.changes) {
    return { ok: false, stale: true, permit };
  }
  return { ok: true, permit };
}
