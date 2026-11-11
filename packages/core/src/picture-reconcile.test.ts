import { describe, expect, it } from 'vitest';
import { ObsPictureLedger, pictureElementKey, showKey, type PictureLedgerState } from './obs-picture-ledger';
import { stoppedPicture, type OnAirPicture, type PictureClip } from './on-air-picture';
import { OutputRecovery, recordPictureRepair } from './output-recovery';
import { groupPictureOps, planPictureReconcile, type PictureOp, type ReconcileContext, type ReconcilePlan } from './picture-reconcile';

const clip = (clipId: string, sourceName: string, sceneName: string, offsetMs: number, continuesFrom?: string): PictureClip =>
  ({ clipId, sourceName, assetId: `asset-${clipId}`, layerId: 'L1', sceneName, offsetMs, continuesFrom });

/** A small timeline: camera A (with a shown caption at 50–80), clip c1, a composition of
 * c2 and c3, c4 continuing c3 on the same decoder after a cut, then camera A held. */
function pictureAt(frame: number): OnAirPicture {
  const ms = (start: number): number => Math.round((frame - start) * 1000 / 30);
  const base = { frame, camera: null, covered: [], sounds: [] as PictureClip[] };
  if (frame < 100) return { ...base, target: { kind: 'scene', sceneName: '机位甲', cueId: 'camA' }, camera: { cueId: 'camA', held: false }, clips: [],
    shows: frame >= 50 && frame < 80 ? [{ cueId: 'show1', actionId: 'show1:a', sceneName: '机位甲', sourceName: '字幕', layerId: 'L2' }] : [] };
  if (frame < 200) return { ...base, target: { kind: 'clip', sceneName: '素材一', clipId: 'c1' }, clips: [clip('c1', 'M1', '素材一', ms(100))], shows: [] };
  if (frame < 300) return { ...base, target: { kind: 'composition', sceneName: '团播联动台·叠加·p', layers: [{ sceneName: '素材二' }, { sceneName: '素材三' }] },
    clips: [clip('c2', 'M2', '素材二', ms(200)), clip('c3', 'M3', '素材三', ms(200))], shows: [],
    sounds: [clip('s1', 'S1', '音效', ms(200))] };
  if (frame < 400) return { ...base, target: { kind: 'clip', sceneName: '素材三', clipId: 'c4' }, clips: [clip('c4', 'M3', '素材三', ms(200), 'c3')], shows: [] };
  return { ...base, target: { kind: 'hold', sceneName: '机位甲', cueId: 'camA' }, camera: { cueId: 'camA', held: true }, clips: [], shows: [] };
}

function context(overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  return { mode: 'live', transport: 'running', now: 0, ready: () => 'ready', budget: new OutputRecovery(), holding: false, ...overrides };
}
/** Sends and acknowledges every op until nothing is left to send. */
function settle(ledger: ObsPictureLedger, picture: OnAirPicture, ctx: ReconcileContext): ReconcilePlan {
  for (let pass = 0; pass < 10; pass++) {
    const plan = planPictureReconcile(picture, ledger.state(), ctx);
    for (const entry of plan.adopted) ledger.adopt(entry.sourceName, entry.clipId);
    if (!plan.ops.length) return plan;
    for (const op of plan.ops) { ledger.sent(op.write, ctx.now); ledger.ack(op.write, ctx.now); }
  }
  throw new Error('对账没有收敛');
}
/** Mulberry32: the same seed gives the same sequence on every machine. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
/** The ledger equals the wanted picture: program, compositions, every wanted decoder and show, nothing else running or shown. */
function expectLedgerEquals(state: PictureLedgerState, picture: OnAirPicture, mode: 'playing' | 'paused'): void {
  expect(state.program).toMatchObject({ state: 'confirmed', value: picture.target.sceneName });
  if (picture.target.kind === 'composition')
    expect(state.compositions.get(picture.target.sceneName)).toMatchObject({ state: 'confirmed', value: JSON.stringify(picture.target.layers.map(layer => layer.sceneName)) });
  const wanted = [...picture.clips, ...picture.covered, ...picture.sounds];
  for (const entry of wanted) expect(state.decoders.get(entry.sourceName)).toMatchObject({ state: 'confirmed', value: { clipId: entry.clipId, mode } });
  for (const [source, known] of state.decoders)
    if (!wanted.some(entry => entry.sourceName === source)) expect(known).toMatchObject({ state: 'confirmed', value: { mode: 'stopped' } });
  const shown = new Set(picture.shows.map(showKey));
  for (const [key, known] of state.shows) expect(known).toMatchObject({ state: 'confirmed', value: { enabled: shown.has(key) } });
  for (const key of shown) expect(state.shows.has(key)).toBe(true);
}

describe('画面按此刻应有的样子对账（2026-11-10 第 1、2 题，01 设计 4.3）', () => {
  it('随机的帧序列和乱序回应下，账最终等于应有，之后一样的不再发（固定种子）', () => {
    for (const seed of [1, 7, 42, 2026, 1110]) {
      const next = random(seed), ledger = new ObsPictureLedger();
      const inFlight: PictureOp[] = [];
      let frame = 0, transport: 'running' | 'paused' = 'running';
      for (let step = 0; step < 400; step++) {
        const roll = next();
        frame = roll < 0.1 ? Math.floor(next() * 480) : Math.min(479, frame + Math.floor(next() * 12));
        if (next() < 0.05) transport = transport === 'running' ? 'paused' : 'running';
        if (next() < 0.02) { ledger.invalidate('OBS 重新连接'); inFlight.length = 0; }
        const plan = planPictureReconcile(pictureAt(frame), ledger.state(), context({ transport, now: step }));
        for (const entry of plan.adopted) ledger.adopt(entry.sourceName, entry.clipId);
        for (const op of plan.ops) { ledger.sent(op.write, step); inFlight.push(op); }
        // Answers come back in any order; some never come.
        for (let answers = Math.floor(next() * (inFlight.length + 1)); answers > 0; answers--) {
          const [op] = inFlight.splice(Math.floor(next() * inFlight.length), 1);
          if (next() < 0.8) ledger.ack(op!.write, step); else ledger.unanswered(op!.write, '没有回应');
        }
      }
      for (const op of inFlight.splice(0)) ledger.ack(op.write, 999);
      const ctx = context({ transport, now: 1000 });
      settle(ledger, pictureAt(frame), ctx);
      expectLedgerEquals(ledger.state(), pictureAt(frame), transport === 'running' ? 'playing' : 'paused');
      expect(planPictureReconcile(pictureAt(frame), ledger.state(), ctx).ops).toEqual([]);
    }
  });

  it('随机失败下，每个元素在同一个应有状态下最多补 1 次，一首歌最多补 20 次（固定种子）', () => {
    for (const seed of [3, 11, 59]) {
      const next = random(seed), ledger = new ObsPictureLedger(), recovery = new OutputRecovery();
      const repairs = new Map<string, number>(); let total = 0, frame = 0;
      for (let step = 0; step < 600; step++) {
        frame = Math.min(479, frame + Math.floor(next() * 6));
        const plan = planPictureReconcile(pictureAt(frame), ledger.state(), context({ now: step, budget: recovery }));
        for (const entry of plan.adopted) ledger.adopt(entry.sourceName, entry.clipId);
        for (const op of plan.ops) {
          if (op.reason === 'repair') {
            const key = `${pictureElementKey(op.write)}@${op.write.target}`;
            repairs.set(key, (repairs.get(key) ?? 0) + 1); total++;
            recordPictureRepair(recovery, pictureElementKey(op.write), op.write.target, step);
          }
          ledger.sent(op.write, step);
          if (next() < 0.3) ledger.fail(op.write, 'OBS 拒绝了'); else ledger.ack(op.write, step);
        }
      }
      expect(Math.max(0, ...repairs.values())).toBeLessThanOrEqual(1);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(20);
    }
  });

  it('账上确认过且一样的不发', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(60), context());
    expect(planPictureReconcile(pictureAt(61), ledger.state(), context())).toEqual({ ops: [], waiting: [], suppressed: [], adopted: [] });
  });

  it('顺序：先停不要的解码器，再更新叠加、切直播场景、开新素材，最后显示或隐藏来源', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(60), context());
    settle(ledger, pictureAt(150), context());
    const ops = planPictureReconcile(pictureAt(250), ledger.state(), context()).ops;
    expect(ops.map(op => op.kind)).toEqual(['decoder.stop', 'composition.update', 'program.switch', 'decoder.start', 'decoder.start', 'decoder.start']);
    expect(ops.every(op => op.reason === 'cut')).toBe(true);
    const shown = planPictureReconcile(pictureAt(60), new ObsPictureLedger().state(), context()).ops;
    expect(shown.at(-1)).toMatchObject({ kind: 'show.set', sourceName: '字幕', enabled: true });
  });

  it('等回应的元素不重发', () => {
    const ledger = new ObsPictureLedger();
    const [op] = planPictureReconcile(pictureAt(10), ledger.state(), context()).ops;
    ledger.sent(op!.write, 0);
    const plan = planPictureReconcile(pictureAt(11), ledger.state(), context());
    expect(plan.ops).toEqual([]);
    expect(plan.waiting).toEqual([{ element: 'program', kind: 'pending', detail: '等 OBS 回应' }]);
  });
});

describe('补的是现在该有的画面：失败补一次，过了切点作废（2026-11-10 第 2 题）', () => {
  it('直播：失败后按此刻应有的补 1 次，再失败标红不再发；到下一个切点当新的发', () => {
    const ledger = new ObsPictureLedger(), recovery = new OutputRecovery();
    const ctx = context({ budget: recovery });
    const first = planPictureReconcile(pictureAt(120), ledger.state(), ctx).ops.find(op => op.kind === 'decoder.start')!;
    ledger.sent(first.write, 0); ledger.fail(first.write, 'OBS 拒绝了');
    const repair = planPictureReconcile(pictureAt(130), ledger.state(), ctx).ops.find(op => op.kind === 'decoder.start')!;
    expect(repair.reason).toBe('repair');
    recordPictureRepair(recovery, pictureElementKey(repair.write), repair.write.target, 1);
    ledger.sent(repair.write, 1); ledger.fail(repair.write, 'OBS 又拒绝了');
    const held = planPictureReconcile(pictureAt(140), ledger.state(), ctx);
    expect(held.ops.some(op => op.kind === 'decoder.start')).toBe(false);
    expect(held.suppressed).toEqual([{ element: 'decoder:M1', target: 'c1:playing', kind: 'repair-limit', detail: '自动补画面已到上限，到下一段会按时间线照常切换' }]);
    // Past the cut point M1 is no longer wanted: its failure no longer applies and it is stopped as new.
    const cut = planPictureReconcile(pictureAt(250), ledger.state(), ctx).ops.find(op => op.write.element === 'decoder' && op.write.key === 'M1')!;
    expect(cut).toMatchObject({ kind: 'decoder.stop', reason: 'cut' });
  });

  it('一首歌补满 20 次以后，别的元素也不再自动补', () => {
    const ledger = new ObsPictureLedger(), recovery = new OutputRecovery();
    for (let index = 0; index < 20; index++) recordPictureRepair(recovery, `decoder:其他${index}`, 'x', index);
    const op = planPictureReconcile(pictureAt(120), ledger.state(), context({ budget: recovery })).ops.find(entry => entry.kind === 'decoder.start')!;
    ledger.sent(op.write, 0); ledger.fail(op.write, 'OBS 拒绝了');
    expect(planPictureReconcile(pictureAt(121), ledger.state(), context({ budget: recovery })).suppressed).toMatchObject([{ element: 'decoder:M1', kind: 'repair-limit' }]);
  });

  it('排练（AGENTS §4.8）：失败的不补；前面已有失败时后面的画面都不发', () => {
    const ledger = new ObsPictureLedger();
    const op = planPictureReconcile(pictureAt(120), ledger.state(), context({ mode: 'rehearsal' })).ops.find(entry => entry.kind === 'decoder.start')!;
    ledger.sent(op.write, 0); ledger.fail(op.write, 'OBS 拒绝了');
    expect(planPictureReconcile(pictureAt(121), ledger.state(), context({ mode: 'rehearsal' })).suppressed).toMatchObject([{ element: 'decoder:M1', kind: 'rehearsal' }]);
    const held = planPictureReconcile(pictureAt(250), ledger.state(), context({ mode: 'rehearsal', holding: true }));
    expect(held.ops).toEqual([]);
    expect(held.suppressed.length).toBeGreaterThan(0);
    expect(held.suppressed.every(item => item.kind === 'rehearsal')).toBe(true);
  });
});

describe('OBS 状态不确定时按此刻应有的全量恢复（01 设计 4.4、4.7）', () => {
  it('重连后场景、叠加、解码器和显示来源全部按应有的发一次，记为恢复', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(60), context());
    settle(ledger, pictureAt(150), context());
    settle(ledger, pictureAt(250), context());
    ledger.invalidate('OBS 重新连接');
    const plan = planPictureReconcile(pictureAt(250), ledger.state(), context());
    expect(plan.ops.map(op => [op.kind, op.reason])).toEqual([
      ['decoder.stop', 'restore'], ['composition.update', 'restore'], ['program.switch', 'restore'],
      ['decoder.start', 'restore'], ['decoder.start', 'restore'], ['decoder.start', 'restore'], ['show.set', 'restore']]);
    expect(plan.ops.find(op => op.kind === 'show.set')).toMatchObject({ sourceName: '字幕', enabled: false });
  });

  it('从没发过的第一遍不算恢复', () => {
    expect(planPictureReconcile(pictureAt(10), new ObsPictureLedger().state(), context()).ops).toMatchObject([{ kind: 'program.switch', reason: 'cut' }]);
  });
});

describe('画面被手动接管：下一段之前不切回（2026-11-10 第 5 题）', () => {
  it('接管期间不发切场景，素材和显示来源照常对；应有画面变了才照常切', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(40), context());
    ledger.takeOver('手动场景', '机位甲', 1);
    const during = planPictureReconcile(pictureAt(60), ledger.state(), context());
    expect(during.ops.map(op => op.kind)).toEqual(['show.set']);
    expect(during.waiting).toEqual([{ element: 'program', kind: 'taken-over', detail: '画面被手动接管（手动场景），到下一段再照常切换' }]);
    const next = planPictureReconcile(pictureAt(150), ledger.state(), context());
    const change = next.ops.find(op => op.kind === 'program.switch')!;
    expect(change).toMatchObject({ sceneName: '素材一' });
    for (const op of next.ops) { ledger.sent(op.write, 2); ledger.ack(op.write, 3); }
    expect(ledger.state().takenOver).toBeNull();
  });
});

describe('切开的同一素材接着播，不重启（media5b D1）', () => {
  it('同一解码器接着放下一段：不发停止和开播，账上改成新片段', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(250), context());
    const plan = planPictureReconcile(pictureAt(310), ledger.state(), context());
    expect(plan.ops.some(op => op.write.element === 'decoder' && op.write.key === 'M3')).toBe(false);
    expect(plan.adopted).toEqual([{ sourceName: 'M3', clipId: 'c4' }]);
    expect(plan.ops.map(op => op.kind)).toEqual(['decoder.stop', 'decoder.stop', 'program.switch']);
  });
});

describe('暂停、准备中和停歌', () => {
  it('暂停：在播的解码器暂停，不重新定位；继续时定位后播放', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(150), context());
    const paused = planPictureReconcile(pictureAt(150), ledger.state(), context({ transport: 'paused' })).ops;
    expect(paused).toMatchObject([{ kind: 'decoder.pause', sourceName: 'M1', clipId: 'c1' }]);
    settle(ledger, pictureAt(150), context({ transport: 'paused' }));
    expect(planPictureReconcile(pictureAt(150), ledger.state(), context({ transport: 'paused' })).ops).toEqual([]);
    // Moved while paused: positioned there, still paused.
    expect(planPictureReconcile(pictureAt(180), ledger.state(), context({ transport: 'paused' })).ops).toMatchObject([{ kind: 'decoder.start', mode: 'paused' }]);
    expect(planPictureReconcile(pictureAt(150), ledger.state(), context()).ops).toMatchObject([{ kind: 'decoder.start', mode: 'playing' }]);
  });

  it('素材还在准备：画面先保持现状，写“还在准备”，不算失败', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(40), context());
    const plan = planPictureReconcile(pictureAt(150), ledger.state(), context({ ready: () => 'preparing' }));
    expect(plan.ops).toEqual([]);
    expect(plan.waiting.map(item => [item.element, item.kind])).toEqual([['decoder:M1', 'preparing'], ['program', 'preparing']]);
    expect(plan.suppressed).toEqual([]);
  });

  it('停歌（2026-11-11 第 3 题）：这首歌打开的显示来源照旧隐藏，场景停在当时那个，音效停下', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(60), context());
    const stopped = stoppedPicture(pictureAt(60));
    const plan = planPictureReconcile(stopped, ledger.state(), context({ transport: 'paused' }));
    expect(plan.ops).toMatchObject([{ kind: 'show.set', sourceName: '字幕', enabled: false }]);
    const composition = new ObsPictureLedger();
    settle(composition, pictureAt(250), context());
    const after = planPictureReconcile(stoppedPicture(pictureAt(250)), composition.state(), context({ transport: 'paused' })).ops;
    expect(after.map(op => op.kind)).toEqual(['decoder.pause', 'decoder.pause', 'decoder.stop']);
    expect(after.some(op => op.kind === 'program.switch' || op.kind === 'composition.update')).toBe(false);
  });
});

describe('同一个切点的请求一起发（沿用现在的分组）', () => {
  it('叠加、切到叠加和最多 8 个层的开播一组；其他开播最多 4 个一组；停止各自单发', () => {
    const start = (index: number, scene = '层'): PictureOp => ({ kind: 'decoder.start', clip: clip(`c${index}`, `M${index}`, scene, 0), mode: 'playing', reason: 'cut',
      write: { element: 'decoder', key: `M${index}`, value: { clipId: `c${index}`, mode: 'playing', offsetMs: 0 }, target: `c${index}:playing` } });
    const composition: PictureOp = { kind: 'composition.update', sceneName: '叠加', layers: [{ sceneName: '层' }], reason: 'cut', write: { element: 'composition', key: '叠加', value: 'x', target: 'x' } };
    const program: PictureOp = { kind: 'program.switch', sceneName: '叠加', reason: 'cut', write: { element: 'program', value: '叠加', target: '叠加' } };
    const stop: PictureOp = { kind: 'decoder.stop', sourceName: 'M0', reason: 'cut', write: { element: 'decoder', key: 'M0', value: { clipId: '', mode: 'stopped', offsetMs: 0 }, target: ':stopped' } };
    const ops = [stop, stop, composition, program, ...Array.from({ length: 10 }, (_, index) => start(index + 1))];
    expect(groupPictureOps(ops).map(group => group.length)).toEqual([1, 1, 10, 2]);
    expect(groupPictureOps(Array.from({ length: 6 }, (_, index) => start(index, '别的'))).map(group => group.length)).toEqual([4, 2]);
    expect(groupPictureOps([start(1), start(1)]).map(group => group.length)).toEqual([1, 1]);
  });
});
