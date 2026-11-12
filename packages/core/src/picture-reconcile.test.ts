import { describe, expect, it } from 'vitest';
import { ObsPictureLedger, pictureElementKey, showKey, showMayBeOn, type LedgerWrite, type PictureLedgerState } from './obs-picture-ledger';
import { stoppedPicture, type OnAirPicture, type PictureClip } from './on-air-picture';
import { OutputRecovery, recordPictureRepair } from './output-recovery';
import { groupPictureOps, pictureOpWrites, pictureProgram, planPictureReconcile, programSignature, whilePaused, type PictureOp, type ReconcileContext, type ReconcilePlan } from './picture-reconcile';

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
    if (!plan.ops.length) return plan;
    for (const op of plan.ops) for (const write of pictureOpWrites(op)) { ledger.sent(write, ctx.now); ledger.ack(write, ctx.now); }
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
  expect(state.program).toMatchObject({ state: 'confirmed', value: { sceneName: picture.target.sceneName } });
  if (picture.target.kind === 'composition')
    expect(state.compositions.get(picture.target.sceneName)).toMatchObject({ state: 'confirmed', value: JSON.stringify(picture.target.layers.map(layer => layer.sceneName)) });
  const wanted = [...picture.clips, ...picture.covered, ...picture.sounds];
  for (const entry of wanted) expect(state.decoders.get(entry.sourceName)).toMatchObject({ state: 'confirmed', value: { clipId: entry.clipId, mode } });
  for (const [source, known] of state.decoders)
    if (!wanted.some(entry => entry.sourceName === source)) expect(known).toMatchObject({ state: 'confirmed', value: { mode: 'stopped' } });
  const shown = new Set(picture.shows.map(showKey));
  // A span not open is off air: confirmed hidden, or not known but with nothing that may still show it.
  for (const [key, known] of state.shows)
    if (shown.has(key)) expect(known).toMatchObject({ state: 'confirmed', value: { enabled: true } });
    else expect(showMayBeOn(known)).toBe(false);
  for (const key of shown) expect(state.shows.has(key)).toBe(true);
}

describe('画面按此刻应有的样子对账（2026-11-10 第 1、2 题，01 设计 4.3）', () => {
  it('随机的帧序列和乱序回应下，账最终等于应有，之后一样的不再发（固定种子）', () => {
    for (const seed of [1, 7, 42, 2026, 1110]) {
      const next = random(seed), ledger = new ObsPictureLedger();
      const inFlight: LedgerWrite[] = [];
      let frame = 0, transport: 'running' | 'paused' = 'running';
      for (let step = 0; step < 400; step++) {
        const roll = next();
        frame = roll < 0.1 ? Math.floor(next() * 480) : Math.min(479, frame + Math.floor(next() * 12));
        if (next() < 0.05) transport = transport === 'running' ? 'paused' : 'running';
        if (next() < 0.02) { ledger.invalidate('OBS 重新连接'); inFlight.length = 0; }
        const plan = planPictureReconcile(pictureAt(frame), ledger.state(), context({ transport, now: step }));
        for (const write of plan.ops.flatMap(pictureOpWrites)) { ledger.sent(write, step); inFlight.push(write); }
        // Answers come back in any order; some never come.
        for (let answers = Math.floor(next() * (inFlight.length + 1)); answers > 0; answers--) {
          const [write] = inFlight.splice(Math.floor(next() * inFlight.length), 1);
          if (next() < 0.8) ledger.ack(write!, step); else ledger.unanswered(write!, '没有回应');
        }
      }
      for (const write of inFlight.splice(0)) ledger.ack(write, 999);
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
    expect(planPictureReconcile(pictureAt(61), ledger.state(), context())).toEqual({ ops: [], waiting: [], suppressed: [] });
  });

  it('顺序：先停不要的解码器，再更新叠加、切直播场景、开新素材，最后显示或隐藏来源', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(60), context());
    settle(ledger, pictureAt(150), context());
    const ops = planPictureReconcile(pictureAt(250), ledger.state(), context()).ops;
    expect(ops.map(op => op.kind)).toEqual(['decoder.stop', 'composition.update', 'program.switch', 'decoder.start', 'decoder.start', 'decoder.start']);
    expect(ops.every(op => op.reason === 'cut')).toBe(true);
    // A show newly due at a cut goes before the switch (it acts on the scene that was live, as
    // today); a restored one, or one in a merged backlog, after the switch and the starts.
    const shown = planPictureReconcile(pictureAt(60), new ObsPictureLedger().state(), context()).ops;
    expect(shown.map(op => op.kind)).toEqual(['show.set', 'program.switch']);
    expect(shown[0]).toMatchObject({ kind: 'show.set', sourceName: '字幕', enabled: true });
    const merged = planPictureReconcile(pictureAt(60), new ObsPictureLedger().state(), context({ merged: true })).ops;
    expect(merged.map(op => op.kind)).toEqual(['program.switch', 'show.set']);
    const restoring = new ObsPictureLedger();
    settle(restoring, pictureAt(60), context()); restoring.invalidate('OBS 重新连接');
    expect(planPictureReconcile(pictureAt(60), restoring.state(), context()).ops.map(op => [op.kind, op.reason]))
      .toEqual([['program.switch', 'restore'], ['show.set', 'restore']]);
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

  it('没回应的（不知道 OBS 做没做）和失败一样：同一个应有状态下补 1 次，再不知道就标红不再发；排练不补；重连以后是恢复不是补（0.5.9 R5）', () => {
    const ledger = new ObsPictureLedger(), recovery = new OutputRecovery(), ctx = context({ budget: recovery });
    const first = planPictureReconcile(pictureAt(120), ledger.state(), ctx).ops.find(op => op.kind === 'decoder.start')!;
    ledger.sent(first.write, 0); ledger.unanswered(first.write, '2 秒没回应');
    expect(planPictureReconcile(pictureAt(121), ledger.state(), context({ mode: 'rehearsal' })).suppressed).toMatchObject([{ element: 'decoder:M1', kind: 'rehearsal' }]);
    const repair = planPictureReconcile(pictureAt(121), ledger.state(), ctx).ops.find(op => op.kind === 'decoder.start')!;
    expect(repair.reason).toBe('repair');
    recordPictureRepair(recovery, pictureElementKey(repair.write), repair.write.target, 1);
    ledger.sent(repair.write, 1); ledger.unanswered(repair.write, '还是没回应');
    expect(planPictureReconcile(pictureAt(122), ledger.state(), ctx).suppressed).toMatchObject([{ element: 'decoder:M1', kind: 'repair-limit' }]);
    ledger.invalidate('OBS 重新连接');
    expect(planPictureReconcile(pictureAt(123), ledger.state(), ctx).ops.find(op => op.kind === 'decoder.start')).toMatchObject({ reason: 'restore' });
  });
});

describe('OBS 状态不确定时按此刻应有的全量恢复（01 设计 4.4、4.7）', () => {
  it('重连后场景、叠加、解码器和显示来源全部按应有的发一次，记为恢复；确认隐藏过的来源不再隐藏，确认停过的解码器不再停', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(60), context());
    settle(ledger, pictureAt(150), context());
    settle(ledger, pictureAt(250), context());
    ledger.invalidate('OBS 重新连接');
    const plan = planPictureReconcile(pictureAt(250), ledger.state(), context());
    // R7: a decoder OBS confirmed stopped stays stopped across the reconnect, like a confirmed hide: no second stop.
    expect(plan.ops.map(op => [op.kind, op.reason])).toEqual([
      ['composition.update', 'restore'], ['program.switch', 'restore'],
      ['decoder.start', 'restore'], ['decoder.start', 'restore'], ['decoder.start', 'restore']]);
    // The subtitle's hide was confirmed before the reconnect: no second hide (it would go to the scene now on program).
    expect(plan.ops.some(op => op.kind === 'show.set')).toBe(false);
  });

  it('从没发过的第一遍不算恢复', () => {
    expect(planPictureReconcile(pictureAt(10), new ObsPictureLedger().state(), context()).ops).toMatchObject([{ kind: 'program.switch', reason: 'cut' }]);
  });
});

describe('画面被手动接管：下一段之前不切回（2026-11-10 第 5 题）', () => {
  it('接管期间不发切场景，素材和显示来源照常对；应有画面变了才照常切', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(40), context());
    ledger.takeOver('手动场景', programSignature(pictureProgram(pictureAt(60).target)!), 1);
    const during = planPictureReconcile(pictureAt(60), ledger.state(), context());
    expect(during.ops.map(op => op.kind)).toEqual(['show.set']);
    expect(during.waiting).toEqual([{ element: 'program', kind: 'taken-over', detail: '画面被手动接管（手动场景），到下一段再照常切换' }]);
    // A single material comes on program with its own start: the switch rides on it.
    const next = planPictureReconcile(pictureAt(150), ledger.state(), context());
    const change = next.ops.find(op => op.kind === 'decoder.start')!;
    expect(change).toMatchObject({ program: { element: 'program', value: { sceneName: '素材一' } } });
    for (const write of next.ops.flatMap(pictureOpWrites)) { ledger.sent(write, 2); ledger.ack(write, 3); }
    expect(ledger.state().takenOver).toBeNull();
  });
});

describe('一个素材上画面：切场景和开播是一步（规则测试 obs-program-session L382）', () => {
  it('解码器还不在这个素材上：不单独切场景，开播带着切；已经在播的素材被机位挡过再露出来：只切场景', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(60), context());
    const ops = planPictureReconcile(pictureAt(150), ledger.state(), context()).ops;
    expect(ops.map(op => op.kind)).toEqual(['show.set', 'decoder.start']);
    expect(ops[1]).toMatchObject({ program: { value: { sceneName: '素材一' } } });
    settle(ledger, pictureAt(150), context());
    ledger.observe({ element: 'program', value: { sceneName: '机位乙', cueId: null } }, 5);
    expect(planPictureReconcile(pictureAt(160), ledger.state(), context()).ops).toMatchObject([{ kind: 'program.switch', sceneName: '素材一' }]);
    // The start refused: the program does not switch to a scene whose material did not start.
    const refused = new ObsPictureLedger();
    settle(refused, pictureAt(60), context());
    const start = planPictureReconcile(pictureAt(150), refused.state(), context({ mode: 'rehearsal' })).ops.find(op => op.kind === 'decoder.start')!;
    for (const write of pictureOpWrites(start)) { refused.sent(write, 1); refused.fail(write, 'OBS 拒绝了'); }
    expect(planPictureReconcile(pictureAt(160), refused.state(), context({ mode: 'rehearsal' })).ops.map(op => op.kind)).toEqual(['show.set']);
  });

  it('被机位挡住的素材：解码器已经在它上面就留着；还没开始的不在机位底下开播', () => {
    const covered = { ...pictureAt(10), covered: [clip('c9', 'M9', '素材九', 500)] };
    expect(planPictureReconcile(covered, new ObsPictureLedger().state(), context()).ops.map(op => op.kind)).toEqual(['program.switch']);
    const ledger = new ObsPictureLedger();
    ledger.observe({ element: 'decoder', key: 'M9', value: { clipId: 'c9', mode: 'playing', offsetMs: 400 } }, 1);
    settle(ledger, covered, context());
    expect(ledger.state().decoders.get('M9')).toMatchObject({ state: 'confirmed', value: { clipId: 'c9', mode: 'playing' } });
  });
});

describe('切开的同一素材接着播，不重启（media5b D1，OBS_SCENE_WORKFLOW 2026-11-10）', () => {
  it('后一段接手前一段在播的解码器：不发停止，发一次接手（输出照常做上画面这一步，不定位不重启）', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(250), context());
    const plan = planPictureReconcile(pictureAt(310), ledger.state(), context());
    expect(plan.ops.map(op => op.kind)).toEqual(['decoder.stop', 'decoder.stop', 'decoder.handover']);
    expect(plan.ops.at(-1)).toMatchObject({ clip: { clipId: 'c4', sourceName: 'M3' }, program: { value: { sceneName: '素材三' } } });
    expect(plan.ops.some(op => op.kind === 'decoder.stop' && op.sourceName === 'M3')).toBe(false);
    for (const write of plan.ops.flatMap(pictureOpWrites)) { ledger.sent(write, 1); ledger.ack(write, 1); }
    expect(ledger.state().decoders.get('M3')).toMatchObject({ state: 'confirmed', value: { clipId: 'c4', mode: 'playing' } });
    expect(planPictureReconcile(pictureAt(320), ledger.state(), context()).ops).toEqual([]);
  });
});

describe('暂停时只暂停解码器（OBS_SCENE_WORKFLOW 2026-11-09）', () => {
  it('暂停中别的画面变化都不发，继续时按那时的位置补上', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(150), context());
    ledger.observe({ element: 'program', value: { sceneName: '别的场景', cueId: null } }, 2);
    const plan = planPictureReconcile(pictureAt(150), ledger.state(), context({ transport: 'paused' }));
    expect(plan.ops.map(op => op.kind)).toEqual(['decoder.pause', 'program.switch']);
    expect(whilePaused(plan).ops).toMatchObject([{ kind: 'decoder.pause', sourceName: 'M1' }]);
  });
});

describe('暂停、准备中和停歌', () => {
  it('暂停：在播的解码器暂停，不重新定位；继续时只接着播，不重新定位；暂停中移了位置才定位', () => {
    const ledger = new ObsPictureLedger();
    settle(ledger, pictureAt(150), context());
    const paused = planPictureReconcile(pictureAt(150), ledger.state(), context({ transport: 'paused' })).ops;
    expect(paused).toMatchObject([{ kind: 'decoder.pause', sourceName: 'M1', clipId: 'c1' }]);
    settle(ledger, pictureAt(150), context({ transport: 'paused' }));
    expect(planPictureReconcile(pictureAt(150), ledger.state(), context({ transport: 'paused' })).ops).toEqual([]);
    // Moved while paused: positioned there, still paused.
    expect(planPictureReconcile(pictureAt(180), ledger.state(), context({ transport: 'paused' })).ops).toMatchObject([{ kind: 'decoder.start', mode: 'paused' }]);
    expect(planPictureReconcile(pictureAt(150), ledger.state(), context()).ops).toMatchObject([{ kind: 'decoder.resume', sourceName: 'M1', clipId: 'c1' }]);
  });

  it('OBS 拒绝过开播或暂停的解码器照样跟着暂停和继续，不重新定位；重连后可能还在播的跟着音乐暂停', () => {
    const write = (mode: 'playing' | 'paused'): LedgerWrite => ({ element: 'decoder', key: 'M1', value: { clipId: 'c1', mode, offsetMs: 1667 }, target: `c1:${mode}` });
    const refusedStart = new ObsPictureLedger();
    refusedStart.sent(write('playing'), 0); refusedStart.fail(write('playing'), '拒绝');
    expect(planPictureReconcile(pictureAt(150), refusedStart.state(), context({ transport: 'paused' })).ops).toMatchObject([{ kind: 'decoder.pause', clipId: 'c1' }]);
    // Running, the same refused start is not sent again by itself.
    expect(planPictureReconcile(pictureAt(150), refusedStart.state(), context({ budget: { allows: () => false } })).ops).toEqual([]);
    const refusedPause = new ObsPictureLedger();
    settle(refusedPause, pictureAt(150), context());
    refusedPause.sent(write('paused'), 1); refusedPause.fail(write('paused'), '拒绝');
    expect(planPictureReconcile(pictureAt(150), refusedPause.state(), context({ transport: 'paused', budget: { allows: () => false } })).ops).toEqual([]);
    expect(planPictureReconcile(pictureAt(150), refusedPause.state(), context()).ops).toMatchObject([{ kind: 'decoder.resume', clipId: 'c1' }]);
    const reconnected = new ObsPictureLedger();
    settle(reconnected, pictureAt(150), context()); reconnected.invalidate('OBS 重新连接');
    expect(whilePaused(planPictureReconcile(pictureAt(150), reconnected.state(), context({ transport: 'paused' }))).ops)
      .toMatchObject([{ kind: 'decoder.pause', clipId: 'c1', reason: 'restore' }]);
  });

  it('同一个来源前后两段紧挨着：前一段先隐藏自己显示的，后一段再显示（每段一个元素）', () => {
    const at = (actionId: string): OnAirPicture => ({ ...pictureAt(60), shows: [{ cueId: actionId, actionId, sceneName: '机位甲', sourceName: '字幕', layerId: 'L2' }] });
    const ledger = new ObsPictureLedger();
    settle(ledger, at('first'), context());
    expect(planPictureReconcile(at('first'), ledger.state(), context()).ops).toEqual([]);
    expect(planPictureReconcile(at('second'), ledger.state(), context()).ops).toMatchObject([
      { kind: 'show.set', enabled: false, write: { target: 'off', value: { span: 'first' } } },
      { kind: 'show.set', enabled: true, write: { target: 'on:second' } }]);
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
      write: { element: 'decoder', key: `M${index}`, value: { clipId: `c${index}`, mode: 'playing', offsetMs: 0 }, target: `c${index}:playing` }, program: null });
    const composition: PictureOp = { kind: 'composition.update', sceneName: '叠加', layers: [{ sceneName: '层' }], reason: 'cut', write: { element: 'composition', key: '叠加', value: 'x', target: 'x' } };
    const program: PictureOp = { kind: 'program.switch', sceneName: '叠加', reason: 'cut', write: { element: 'program', value: { sceneName: '叠加', cueId: null }, target: '叠加' } };
    const stop: PictureOp = { kind: 'decoder.stop', sourceName: 'M0', reason: 'cut', write: { element: 'decoder', key: 'M0', value: { clipId: '', mode: 'stopped', offsetMs: 0 }, target: ':stopped' } };
    const ops = [stop, stop, composition, program, ...Array.from({ length: 10 }, (_, index) => start(index + 1))];
    expect(groupPictureOps(ops).map(group => group.length)).toEqual([1, 1, 10, 2]);
    expect(groupPictureOps(Array.from({ length: 6 }, (_, index) => start(index, '别的'))).map(group => group.length)).toEqual([4, 2]);
    expect(groupPictureOps([start(1), start(1)]).map(group => group.length)).toEqual([1, 1]);
  });
});
