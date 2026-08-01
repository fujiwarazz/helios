let counter = 0;

export function uid(prefix: string): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
