import { ma2SyncSnapshotSchema, type Ma2SyncObject, type Ma2SyncSnapshot } from '@tb/schema';

export type Ma2SyncConflict = {
  id: string;
  base: Ma2SyncObject | null;
  local: Ma2SyncObject | null;
  remote: Ma2SyncObject | null;
};
export type Ma2SyncChoice = 'local' | 'remote';
export type Ma2SyncPreview = {
  base: Ma2SyncSnapshot;
  local: Ma2SyncSnapshot;
  remote: Ma2SyncSnapshot;
  merged: Ma2SyncObject[];
  conflicts: Ma2SyncConflict[];
};

export function previewMa2Sync(baseInput: unknown, localInput: unknown, remoteInput: unknown): Ma2SyncPreview {
  const base = ma2SyncSnapshotSchema.parse(baseInput);
  const local = ma2SyncSnapshotSchema.parse(localInput);
  const remote = ma2SyncSnapshotSchema.parse(remoteInput);
  for (const snapshot of [local, remote]) {
    if (snapshot.bindingId !== base.bindingId) throw new Error('MA2 对象绑定已变化，请重新绑定');
    if (snapshot.consoleVersion !== base.consoleVersion) throw new Error('MA2 软件版本变了，需要重新验证格式');
  }
  const indexes = [base, local, remote].map((snapshot) => new Map(snapshot.objects.map((object) => [object.id, object])));
  const [baseIndex, localIndex, remoteIndex] = indexes;
  if (!baseIndex || !localIndex || !remoteIndex) throw new Error('同步快照索引不完整');
  const ids = new Set([...baseIndex.keys(), ...localIndex.keys(), ...remoteIndex.keys()]);
  const merged: Ma2SyncObject[] = [];
  const conflicts: Ma2SyncConflict[] = [];
  for (const id of [...ids].sort()) {
    const before = baseIndex.get(id) ?? null;
    const ours = localIndex.get(id) ?? null;
    const theirs = remoteIndex.get(id) ?? null;
    let selected: Ma2SyncObject | null;
    if (sameObject(ours, theirs)) selected = ours;
    else if (sameObject(before, ours)) selected = theirs;
    else if (sameObject(before, theirs)) selected = ours;
    else {
      selected = before && ours && theirs ? mergeProperties(before, ours, theirs) : null;
      if (!selected) {
        conflicts.push({ id, base: before, local: ours, remote: theirs });
        continue;
      }
    }
    if (selected) merged.push(selected);
  }
  return { base, local, remote, merged, conflicts };
}

function mergeProperties(base: Ma2SyncObject, local: Ma2SyncObject, remote: Ma2SyncObject): Ma2SyncObject | null {
  // Changes to hierarchy or type can alter the meaning of the properties.
  if ([local, remote].some((object) => object.kind !== base.kind || object.parentId !== base.parentId || (base.kind !== 'track' && object.order !== base.order))) return null;
  const order = local.order === remote.order || remote.order === base.order ? local.order : local.order === base.order ? remote.order : null;
  if (order === null) return null;
  const properties: Record<string, string> = {};
  const keys = new Set([...Object.keys(base.properties), ...Object.keys(local.properties), ...Object.keys(remote.properties)]);
  for (const key of keys) {
    const before = Object.hasOwn(base.properties, key) ? base.properties[key] : undefined;
    const ours = Object.hasOwn(local.properties, key) ? local.properties[key] : undefined;
    const theirs = Object.hasOwn(remote.properties, key) ? remote.properties[key] : undefined;
    let value: string | undefined;
    if (ours === theirs || before === theirs) value = ours;
    else if (before === ours) value = theirs;
    else return null;
    // A missing property is a deletion, distinct from an empty string.
    if (value !== undefined) Object.defineProperty(properties, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return { ...base, order, properties };
}

export function resolveMa2Sync(preview: Ma2SyncPreview, choices: ReadonlyMap<string, Ma2SyncChoice>): Ma2SyncSnapshot {
  // Recompute so a changed preview cannot bypass conflict detection.
  const current = previewMa2Sync(preview.base, preview.local, preview.remote);
  const objects = [...current.merged];
  for (const conflict of current.conflicts) {
    const choice = choices.get(conflict.id);
    if (choice !== 'local' && choice !== 'remote') throw new Error(`请处理同步冲突：${conflict.id}`);
    const selected = conflict[choice];
    if (selected) objects.push(selected);
  }
  // Independent deletions and additions can produce dangling parents after merging.
  return ma2SyncSnapshotSchema.parse({ ...current.remote, objects });
}

export function sameMa2Content(leftInput: Ma2SyncSnapshot, rightInput: Ma2SyncSnapshot): boolean {
  const left = ma2SyncSnapshotSchema.parse(leftInput);
  const right = ma2SyncSnapshotSchema.parse(rightInput);
  if (left.bindingId !== right.bindingId || left.consoleVersion !== right.consoleVersion || left.objects.length !== right.objects.length) return false;
  const rightIndex = new Map(right.objects.map((object) => [object.id, object]));
  return left.objects.every((object) => sameObject(object, rightIndex.get(object.id) ?? null));
}

function sameObject(left: Ma2SyncObject | null, right: Ma2SyncObject | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.id !== right.id || left.kind !== right.kind || left.parentId !== right.parentId || left.order !== right.order) return false;
  const keys = Object.keys(left.properties);
  return keys.length === Object.keys(right.properties).length
    && keys.every((key) => Object.hasOwn(right.properties, key) && left.properties[key] === right.properties[key]);
}
