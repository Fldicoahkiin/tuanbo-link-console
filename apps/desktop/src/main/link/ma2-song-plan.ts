import type { Ma2SongSyncRequest } from '@tb/schema';
import { inspectMa2SequenceXml, ma2SequenceCueFingerprints } from './ma2-timecode-xml';

/** Three-way comparison of names/content. Never infer a remote Cue's timeline time. */
export function planMa2SongSync(request: Ma2SongSyncRequest, remoteXml: string | null) {
  const binding = request.binding;
  const remote = remoteXml ? inspectMa2SequenceXml(remoteXml).sequences[0]! : null;
  const base = binding ? inspectMa2SequenceXml(binding.baselineXml).sequences[0]! : null;
  if (binding && (!remote || remote.number !== binding.sequence || base?.number !== binding.sequence)) throw new Error('本曲控台序列已消失或绑定不一致，请核对；不会重建覆盖');
  const baseHashes = binding ? ma2SequenceCueFingerprints(binding.baselineXml) : new Map<string, string>();
  const remoteHashes = remoteXml ? ma2SequenceCueFingerprints(remoteXml) : new Map<string, string>();
  const target = binding?.sequence ?? request.settings.nextSequence;
  const occupied = new Set(remote?.cues.map(cue => Number(cue.number)));
  let next = Math.max(0, ...occupied) + 1;
  const points: Array<{ id: string; cue: string }> = []; const removed: string[] = []; const deletions: string[] = [];
  const changes: Array<{ cue: string; name: string; refs?: Ma2SongSyncRequest['points'][number]['cues'] }> = [];
  let name = request.name;
  if (base && remote && remote.name !== base.name) {
    if (request.name !== base.name && request.name !== remote.name) throw new Error('歌曲序列名称两边同时修改，请核对后再同步');
    name = remote.name || request.name;
  }
  for (const point of request.points) {
    if (point.cues.some(cue => cue.delayMs !== 0)) throw new Error(`“${point.name || '未命名 Cue'}”包含延迟，不能压成控台单步；请先拆为时间线点位`);
    const old = binding?.points.find(value => value.id === point.id);
    const baseCue = old ? base?.cues.find(value => Number(value.number) === Number(old.cue)) : undefined;
    const remoteCue = old ? remote?.cues.find(value => Number(value.number) === Number(old.cue)) : undefined;
    const self = point.cues.length === 1 && point.cues[0]?.sequence === target;
    const contentChanged = old ? !self || Number(point.cues[0]?.cue) !== Number(old.cue) : true;
    const nameChanged = old ? point.name !== (baseCue?.name ?? '') : true;
    if (old && !remoteCue) {
      if (contentChanged || nameChanged) throw new Error(`Cue ${old.cue} 已在控台删除，但软件还有修改，请先核对`);
      removed.push(point.id); continue;
    }
    if (old && (contentChanged || nameChanged) && baseHashes.get(old.cue) !== remoteHashes.get(old.cue)) {
      if (contentChanged || point.name !== remoteCue?.name) throw new Error(`Cue ${old.cue} 两边同时修改，已停止同步，保留两边内容`);
    }
    const candidate = !old && self ? remote?.cues.find(value => Number(value.number) === Number(point.cues[0]?.cue)) : undefined;
    const adopted = candidate && !binding?.points.some(value => Number(value.cue) === Number(candidate.number));
    const number = old?.cue ?? (adopted ? candidate.number : `${next++}.000`);
    if (Number(number) > 9999) throw new Error('歌曲序列 Cue 编号已超过 9999');
    if (points.some(value => Number(value.cue) === Number(number))) throw new Error('同一控台 Cue 已对应另一个时间线点位');
    points.push({ id: point.id, cue: number });
    if (adopted) continue;
    if (contentChanged || nameChanged) changes.push({ cue: number, name: point.name || remoteCue?.name || `Cue ${Number(number)}`, ...(contentChanged ? { refs: point.cues } : {}) });
  }
  for (const old of binding?.points ?? []) if (!request.points.some(value => value.id === old.id) && remoteHashes.has(old.cue)) {
    if (!request.confirmedDeletions?.some(cue => Number(cue) === Number(old.cue))) throw new Error(`待核对删除清单：Sequence ${target} Cue ${old.cue}；软件已删除，控台保留，确认后再同步`);
    if (baseHashes.get(old.cue) !== remoteHashes.get(old.cue)) throw new Error(`Cue ${old.cue} 已在控台修改，不能按旧清单删除`);
    deletions.push(old.cue);
  }
  return { sequence: target, name, points, removed, changes, deletions };
}
