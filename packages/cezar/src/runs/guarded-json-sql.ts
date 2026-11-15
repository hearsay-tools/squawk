/**
 * `sql`, a condition that reads the JSON of `columns` (`summary` by default), as one that answers
 * `onBad` for a row where any of them is not JSON. SQLite's JSON functions fail the whole statement
 * on one such row, so every query that reads stored JSON across rows goes through this
 * (hearsay-tools/squawk#3530). `onBad` 1 selects the row for a caller that decodes it from its
 * record; 0 leaves it out.
 */
export function guardedJsonSql(sql: string, onBad: 0 | 1, columns: readonly string[] = ['summary']): string {
  return `CASE WHEN ${columns.map((column) => `json_valid(${column})`).join(' AND ')} THEN (${sql}) ELSE ${onBad} END`;
}
