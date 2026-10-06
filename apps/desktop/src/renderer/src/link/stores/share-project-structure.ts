import type { LinkProject } from '@tb/schema';

/** Both inputs have already passed the command/schema boundary. Reuse unchanged
 * JSON branches so history retains edits rather than 100 complete Show copies.
 * Never mutate either input; validation is deliberately not skipped here. */
export function shareProjectStructure(before: LinkProject, next: LinkProject): LinkProject {
  return share(before, next) as LinkProject;
}

function share(before: unknown, next: unknown): unknown {
  if (Object.is(before, next)) return before;
  if (before === null || next === null || typeof before !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(before)) return next;
    let unchanged = before.length === next.length;
    const result = next.map((value: unknown, index: number) => {
      const shared = share(before[index], value);
      if (shared !== before[index]) unchanged = false;
      return shared;
    });
    return unchanged ? before : result;
  }
  if (Array.isArray(before)) return next;
  const previous = before as Record<string, unknown>, value = next as Record<string, unknown>;
  const keys = Object.keys(value);
  let unchanged = Object.keys(previous).length === keys.length;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const child = share(previous[key], value[key]);
    if (!Object.hasOwn(previous, key) || child !== previous[key]) unchanged = false;
    Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
  }
  return unchanged ? before : result;
}
