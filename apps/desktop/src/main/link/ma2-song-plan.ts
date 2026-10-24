import type { Ma2SongSyncRequest } from '@tb/schema';
import { consoleLabelText, toConsoleLabel } from '@tb/core/link';
import { inspectMa2SequenceXml } from './ma2-timecode-xml';

type Refs = Ma2SongSyncRequest['points'][number]['cues'];
export type Ma2SongPlan = {
  sequence: number; name: string; points: Array<{ id: string; cue: string }>;
  changes: Array<{ cue: string; name: string; refs?: Refs; restore?: boolean }>;
  deletions: string[];
  /** Cues the console no longer holds that this sync writes again. */
  restored: string[];
};

/** Cue numbers in thousandths, the finest step grandMA2 keeps. */
const milli = (cue: string): number => Math.round(Number(cue) * 1000);
const cueText = (value: number): string => `${Math.floor(value / 1000)}.${String(value % 1000).padStart(3, '0')}`;
const MAX_CUE = 9999 * 1000 + 999;

/**
 * A number between two Cues so the Sequence reads, and steps with Go, in song order: the next
 * whole number when it still sits before the following Cue, otherwise a fraction; null when the
 * gap has no free number.
 */
function cueBetween(low: number, high: number | undefined, taken: (value: number) => boolean): number | null {
  const ceiling = Math.min(high ?? MAX_CUE + 1, MAX_CUE + 1);
  const whole = (Math.floor(low / 1000) + 1) * 1000;
  if (whole < ceiling && !taken(whole)) return whole;
  // Song Cues start at 1: a point before the first Cue takes a number after the last instead.
  const middle = Math.floor((low + ceiling) / 2);
  if (middle >= 1000 && middle > low && middle < ceiling && !taken(middle)) return middle;
  for (let value = Math.max(low + 1, 1000); value < ceiling; value++) if (!taken(value)) return value;
  return null;
}

/**
 * The song's timeline decides what its own Sequence holds:
 * - a point added, or given other material, writes its Cue; a point deleted deletes its Cue, and a
 *   point added in the same sync may take over that number (it is written fresh, nothing of the
 *   deleted Cue is kept), so deleting and adding the same steps never piles Cues up;
 * - a point pasted back that still refers to a deleted point's Cue keeps that Cue as it is;
 * - a Cue deleted on the console is written again from the last confirmed snapshot, and a
 *   Sequence missing from the console is created again the same way;
 * - a Cue renamed or stored again on the console keeps that, unless the software changed the
 *   same point's name or material since the last sync;
 * - a Cue added on the console stays until a point takes it. A console Cue's time is never guessed.
 */
export function planMa2SongSync(request: Ma2SongSyncRequest, remoteXml: string | null, restoredCues: readonly string[] = []): Ma2SongPlan {
  const binding = request.binding;
  const remote = remoteXml ? inspectMa2SequenceXml(remoteXml).sequences[0]! : null;
  const base = binding ? inspectMa2SequenceXml(binding.baselineXml).sequences[0]! : null;
  if (binding && (base?.number !== binding.sequence || remote && remote.number !== binding.sequence)) throw new Error(`本曲控台序列 ${binding.sequence} 与上次核对的内容编号不一致，未写入；请从控台刷新后核对`);
  const target = binding?.sequence ?? request.settings.nextSequence;
  // Names are written as pinyin. A Chinese name an earlier version wrote still counts as equal,
  // so nothing on the console is renamed until the operator asks for rewriteLegacyNames.
  const sameName = (local: string, console: string | null | undefined): boolean => (console ?? '') === consoleLabelText(local) || !request.rewriteLegacyNames && (console ?? '') === local;
  const written = (local: string): string => local ? toConsoleLabel(local) : '';
  const renamedHere = !base || !sameName(request.name, base.name);
  const chosenName = renamedHere || !remote?.name ? request.name : remote.name;
  const name = remote?.name && sameName(chosenName, remote.name) ? remote.name : toConsoleLabel(chosenName);
  const onConsole = new Set(remote?.cues.map(cue => milli(cue.number)));
  const bound = new Set(binding?.points.map(point => milli(point.cue)));
  const selfCue = (point: Ma2SongSyncRequest['points'][number]): number | undefined => point.cues.length === 1 && point.cues[0]!.sequence === target ? milli(point.cues[0]!.cue) : undefined;
  // The confirmed point each timeline point continues: its own, or a deleted point whose Cue it still names.
  const previous = new Map<string, { id: string; cue: string }>();
  for (const point of request.points) {
    const old = binding?.points.find(value => value.id === point.id);
    if (old) previous.set(point.id, old);
  }
  const continued = new Set([...previous.values()].map(old => old.id));
  for (const point of request.points) {
    if (previous.has(point.id)) continue;
    const cue = selfCue(point);
    const old = cue === undefined ? undefined : binding?.points.find(value => milli(value.cue) === cue && !continued.has(value.id) && !request.points.some(other => other.id === value.id));
    if (old) { previous.set(point.id, old); continued.add(old.id); }
  }
  // Numbers whose point left the timeline: deleted on the console, free for a point added now.
  const freed = new Set((binding?.points ?? []).filter(old => !continued.has(old.id) && !request.points.some(point => point.id === old.id)).map(old => milli(old.cue)));
  const numbers = new Map<string, number>();
  const changes: Ma2SongPlan['changes'] = []; const restored: string[] = [];
  const adopted = new Set<string>();
  for (const point of request.points) {
    if (point.cues.some(cue => cue.delayMs !== 0)) throw new Error(`“${point.name || '未命名 Cue'}”包含延迟，不能压成控台单步；请先拆为时间线点位`);
    const old = previous.get(point.id);
    if (old) { numbers.set(point.id, milli(old.cue)); continue; }
    // A Cue added on the console and dragged onto the timeline becomes this point's Cue as it is.
    const candidate = selfCue(point);
    if (candidate !== undefined && onConsole.has(candidate) && !bound.has(candidate) && ![...numbers.values()].includes(candidate)) {
      numbers.set(point.id, candidate); adopted.add(point.id);
    }
  }
  const used = (value: number): boolean => (onConsole.has(value) || bound.has(value)) && !freed.has(value) || [...numbers.values()].includes(value);
  for (const [index, point] of request.points.entries()) {
    if (numbers.has(point.id)) continue;
    const low = Math.max(0, ...request.points.slice(0, index).flatMap(value => numbers.has(value.id) ? [numbers.get(value.id)!] : []));
    const following = request.points.slice(index + 1).flatMap(value => numbers.has(value.id) && numbers.get(value.id)! > low ? [numbers.get(value.id)!] : []);
    const value = cueBetween(low, following.length ? Math.min(...following) : undefined, used)
      ?? cueBetween(Math.max(0, ...[...onConsole, ...bound].filter(number => !freed.has(number)), ...numbers.values()), undefined, used);
    if (value === null) throw new Error('歌曲序列 Cue 编号已超过 9999');
    numbers.set(point.id, value);
  }
  const points = request.points.map(point => ({ id: point.id, cue: cueText(numbers.get(point.id)!) }));
  for (const point of request.points) {
    if (adopted.has(point.id)) continue;
    const number = cueText(numbers.get(point.id)!);
    const fallback = `Cue ${Number(number)}`;
    const old = previous.get(point.id);
    if (!old) { changes.push({ cue: number, name: written(point.name) || fallback, refs: point.cues }); continue; }
    const baseCue = base?.cues.find(value => Number(value.number) === Number(old.cue));
    const remoteCue = remote?.cues.find(value => Number(value.number) === Number(old.cue));
    const restore = restoredCues.includes(old.cue);
    const contentChanged = restore || selfCue(point) !== milli(old.cue);
    const renamed = !sameName(point.name, baseCue?.name);
    if (!remoteCue) {
      changes.push({ cue: number, name: written(point.name) || baseCue?.name || fallback, refs: point.cues, ...(!contentChanged || restore ? { restore: true } : {}) });
      restored.push(number);
      continue;
    }
    if (contentChanged || renamed) changes.push({ cue: number, name: renamed ? written(point.name) || fallback : remoteCue.name || written(point.name) || fallback, ...(contentChanged ? { refs: point.cues, ...(restore ? { restore: true } : {}) } : {}) });
  }
  // A freed number a new point took is deleted too: the write replaces that Cue instead of editing it.
  const deletions = [...freed].filter(value => onConsole.has(value)).sort((a, b) => a - b).map(cueText);
  return { sequence: target, name, points, changes, deletions, restored };
}
