// Narrow reads of parsed JSON from files and native client output, which the Wizard does not control.

export function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
