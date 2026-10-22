import type { Ma2SongConflict, Ma2SongSyncRequest } from '@tb/schema';
import { consoleLabelText, toConsoleLabel } from '@tb/core/link';
import { createHash } from 'node:crypto';
import { editMa2SongSequence, inspectMa2SequenceXml, ma2SequenceCueFingerprints } from './ma2-timecode-xml';

/** Three-way comparison of names/content. Never infer a remote Cue's timeline time. */
export function planMa2SongSync(request: Ma2SongSyncRequest, remoteXml: string | null, restoredCues: readonly string[] = []) {
  const binding = request.binding;
  const remote = remoteXml ? inspectMa2SequenceXml(remoteXml).sequences[0]! : null;
  const base = binding ? inspectMa2SequenceXml(binding.baselineXml).sequences[0]! : null;
  if (binding && (!remote || remote.number !== binding.sequence || base?.number !== binding.sequence)) throw new Error('本曲控台序列已消失或绑定不一致，请核对；不会重建覆盖');
  const baseHashes = binding ? ma2SequenceCueFingerprints(binding.baselineXml) : new Map<string, string>();
  const remoteHashes = remoteXml ? ma2SequenceCueFingerprints(remoteXml) : new Map<string, string>();
  const baseContent = binding ? ma2SequenceCueFingerprints(binding.baselineXml, false) : new Map<string, string>();
  const remoteContent = remoteXml ? ma2SequenceCueFingerprints(remoteXml, false) : new Map<string, string>();
  const target = binding?.sequence ?? request.settings.nextSequence;
  const occupied = new Set(remote?.cues.map(cue => Number(cue.number)));
  let next = Math.max(0, ...occupied) + 1;
  const points: Array<{ id: string; cue: string }> = []; const removed: string[] = []; const deletions: string[] = [];
  const changes: Array<{ cue: string; name: string; refs?: Ma2SongSyncRequest['points'][number]['cues']; restore?: boolean }> = [];
  const conflicts: Ma2SongConflict[] = [];
  const conflict = (value: Omit<Ma2SongConflict, 'token'>, context: unknown): 'local' | 'console' | undefined => {
    const token = createHash('sha256').update(JSON.stringify([target, value, context])).digest('hex');
    const decision = request.conflictResolutions?.find(resolution => resolution.key === value.key && resolution.token === token);
    if (decision) return decision.choice;
    conflicts.push({ ...value, token }); return undefined;
  };
  const describe = (refs: Ma2SongSyncRequest['points'][number]['cues']): string => refs.length ? refs.map(ref => `序列 ${ref.sequence} · Cue ${ref.cue}`).join(' + ') : '空 Cue';
  // Names are written as pinyin. A Chinese name an earlier version wrote still counts as equal,
  // so nothing on the console is renamed until the operator asks for rewriteLegacyNames.
  const sameName = (local: string, console: string | null | undefined): boolean => (console ?? '') === consoleLabelText(local) || !request.rewriteLegacyNames && (console ?? '') === local;
  const written = (local: string): string => local ? toConsoleLabel(local) : '';
  let name = request.name;
  if (base && remote && remote.name !== base.name) {
    const decision = !sameName(request.name, base.name) && !sameName(request.name, remote.name)
      ? conflict({ key: 'sequence-name', field: 'sequence-name', baseline: base.name ?? '', local: request.name, console: remote.name ?? '' }, [base.name, remote.name]) : 'console';
    name = decision === 'local' ? request.name : remote.name || request.name;
  }
  name = remote?.name && sameName(name, remote.name) ? remote.name : toConsoleLabel(name);
  for (const point of request.points) {
    if (point.cues.some(cue => cue.delayMs !== 0)) throw new Error(`“${point.name || '未命名 Cue'}”包含延迟，不能压成控台单步；请先拆为时间线点位`);
    const old = binding?.points.find(value => value.id === point.id);
    const baseCue = old ? base?.cues.find(value => Number(value.number) === Number(old.cue)) : undefined;
    const remoteCue = old ? remote?.cues.find(value => Number(value.number) === Number(old.cue)) : undefined;
    const self = point.cues.length === 1 && point.cues[0]?.sequence === target;
    const restore = old && restoredCues.includes(old.cue);
    let contentChanged = old ? restore || !self || Number(point.cues[0]?.cue) !== Number(old.cue) : true;
    let nameChanged = old ? !sameName(point.name, baseCue?.name) : true;
    if (old && !remoteCue) {
      const decision = contentChanged || nameChanged ? conflict({ key: `${point.id}:cue-removed`, field: 'cue-removed', pointId: point.id, cue: old.cue,
        baseline: baseCue?.name ?? `Cue ${old.cue}`, local: `${point.name} · ${describe(point.cues)}`, console: '控台已删除' }, [baseHashes.get(old.cue), point]) : 'console';
      if (decision === 'console') { removed.push(point.id); continue; }
      points.push(old);
      if (decision === 'local') changes.push({ cue: old.cue, name: written(point.name) || `Cue ${Number(old.cue)}`, refs: point.cues, ...(!contentChanged || restore ? { restore: true } : {}) });
      continue;
    }
    if (old && contentChanged && baseContent.get(old.cue) !== remoteContent.get(old.cue)) {
      const decision = conflict({ key: `${point.id}:cue-content`, field: 'cue-content', pointId: point.id, cue: old.cue,
        baseline: `序列 ${target} · Cue ${old.cue}（上次回读）`, local: describe(point.cues), console: `序列 ${target} · Cue ${old.cue}（控台已修改灯光）` },
      [baseContent.get(old.cue), remoteContent.get(old.cue), point.cues]);
      if (decision !== 'local') contentChanged = false;
    }
    if (old && nameChanged && remoteCue?.name !== baseCue?.name && !sameName(point.name, remoteCue?.name)) {
      const decision = conflict({ key: `${point.id}:cue-name`, field: 'cue-name', pointId: point.id, cue: old.cue,
        baseline: baseCue?.name ?? '', local: point.name, console: remoteCue?.name ?? '' }, [baseCue?.name, remoteCue?.name]);
      if (decision !== 'local') nameChanged = false;
    }
    const candidate = !old && self ? remote?.cues.find(value => Number(value.number) === Number(point.cues[0]?.cue)) : undefined;
    const adopted = candidate && !binding?.points.some(value => Number(value.cue) === Number(candidate.number));
    const number = old?.cue ?? (adopted ? candidate.number : `${next++}.000`);
    if (Number(number) > 9999) throw new Error('歌曲序列 Cue 编号已超过 9999');
    if (points.some(value => Number(value.cue) === Number(number))) throw new Error('同一控台 Cue 已对应另一个时间线点位');
    points.push({ id: point.id, cue: number });
    if (adopted) continue;
    if (contentChanged || nameChanged) changes.push({ cue: number, name: nameChanged ? written(point.name) || remoteCue?.name || `Cue ${Number(number)}` : remoteCue?.name || written(point.name) || `Cue ${Number(number)}`, ...(contentChanged ? { refs: point.cues, ...(restore ? { restore: true } : {}) } : {}) });
  }
  for (const old of binding?.points ?? []) if (!request.points.some(value => value.id === old.id) && remoteHashes.has(old.cue)) {
    const confirmed = request.confirmedDeletions?.some(cue => Number(cue) === Number(old.cue)) && baseHashes.get(old.cue) === remoteHashes.get(old.cue);
    const decision = confirmed ? 'local' : conflict({ key: `${old.id}:cue-deletion`, field: 'cue-deletion', pointId: old.id, cue: old.cue,
      baseline: base?.cues.find(cue => Number(cue.number) === Number(old.cue))?.name ?? `Cue ${old.cue}`, local: '软件已移除', console: remote?.cues.find(cue => Number(cue.number) === Number(old.cue))?.name ?? `Cue ${old.cue}` },
    [baseHashes.get(old.cue), remoteHashes.get(old.cue)]);
    if (decision === 'local') deletions.push(old.cue);
    else if (!decision) points.push(old);
  }
  return { sequence: target, name, points, removed, changes, deletions, conflicts };
}

/** Advance only acknowledged fields; unresolved differences survive save/reopen. */
export function ma2SongSyncBaseline(request: Ma2SongSyncRequest, verifiedXml: string, conflicts: readonly Ma2SongConflict[]): string {
  if (!request.binding || !conflicts.length) return verifiedXml;
  const base = inspectMa2SequenceXml(request.binding.baselineXml).sequences[0]!;
  const remote = inspectMa2SequenceXml(verifiedXml).sequences[0]!;
  const changes = [...new Set(conflicts.flatMap(value => value.cue ? [value.cue] : []))].flatMap(cue => {
    const previous = base.cues.find(value => Number(value.number) === Number(cue));
    const actual = remote.cues.find(value => Number(value.number) === Number(cue));
    if (!previous) return [];
    const fields = conflicts.filter(value => value.cue === cue).map(value => value.field);
    const whole = fields.includes('cue-deletion') || fields.includes('cue-removed');
    return [{ cue, name: whole || fields.includes('cue-name') ? previous.name ?? '' : actual?.name ?? '',
      ...(whole || fields.includes('cue-content') ? { sources: [{ xml: request.binding!.baselineXml, cue }] } : {}) }];
  });
  return editMa2SongSequence(verifiedXml, conflicts.some(value => value.field === 'sequence-name') ? base.name ?? request.name : remote.name ?? request.name, changes, []);
}
