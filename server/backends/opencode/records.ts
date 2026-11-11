// Readers for the JSON OpenCode returns: a value that is not the expected
// shape reads as absent, never as an error.

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

export function numberField(
  value: Record<string, unknown>,
  key: string,
): number | null {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : null;
}

export function positiveNumber(record: Record<string, unknown>, field: string) {
  const value = numberField(record, field);
  return value !== null && value > 0 ? value : null;
}

export function listData(raw: unknown): unknown[] {
  const data = asRecord(raw).data;
  return Array.isArray(data) ? data : [];
}
