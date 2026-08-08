/** Recursively freeze an owned plain-data graph in place. */
export function freezeDeep<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

/** Clone plain validated data and deeply freeze the independent result snapshot. */
export function immutableSnapshot<T>(value: T): T {
  return freezeDeep(structuredClone(value));
}
