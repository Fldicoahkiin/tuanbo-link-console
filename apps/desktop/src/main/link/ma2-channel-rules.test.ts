import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isShowWait, type ShowState } from '@tb/core/link';
import { Ma2LuaConsole } from './fixtures/ma2-lua-console';
import { idleShow, pausedShow, runningShow, showReader } from './fixtures/show-gates';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2BridgeFailure, Ma2OnpcBridge, ma2StepGate, ma2WriteStep } from './ma2-onpc-bridge';

// M3, 第 3 题 (2026-11-10): a sync on the console stops at a step boundary once the time code starts. The real
// tools/ma2/tblink_bridge.lua runs here in Lua 5.3 against the fake console, behind the real wire and bridge.
// 1. The step on the console finishes, the next one is not sent, the request is released at once, and the stop is a
//    wait (isShowWait), not a failure.
// 2. The write step is never cut, and the read-back after it is never held: a request either stops before its write
//    (sent: false, the console holds what it held) or ends confirmed.
// 3. Stopped and synced again from the start, the console ends up exactly as after one uninterrupted sync.
// 4. Paused, every step runs as when stopped. What may run at any time (the version check) is never held.

const timecode = readFileSync(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = readFileSync(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
// Timecode 9902 fires Sequence 9901; the edit moves its second Cue and adds one from Sequence 9903.
const sequence9903 = sequence.replace('<Sequ index="9900"', '<Sequ index="9902"');
const desired = timecode.replace('time="45"', 'time="60"').replace('</SubTrack>', '<Event index="2" time="90" command="Goto" pressed="true" step="3"><Cue name="Cue 1.25"><No>1</No><No>9903</No><No>1</No></Cue></Event></SubTrack>');

function consoleWithShow(): Ma2LuaConsole {
  const ma2 = new Ma2LuaConsole();
  ma2.set('Timecode 9902', { xml: timecode, name: 'TBLINK_FRACTIONAL_TIMECODE' });
  ma2.set('Sequence 9901', { xml: sequence, name: 'TBLINK_CUE_REFERENCE_ACCEPTANCE', label: 'A' });
  ma2.set('Sequence 9903', { xml: sequence9903, name: 'TBLINK_CUE_REFERENCE_ACCEPTANCE', label: 'B' });
  return ma2;
}

/** A console and a bridge whose show starts moving while the `at`-th plugin step (run or step line) runs. */
function rig(start: ShowState = idleShow) {
  const ma2 = consoleWithShow();
  let show = start; let steps = 0; let at: number | null = null; let moving: ShowState = runningShow;
  ma2.beforeLine = line => {
    if (!/','(?:run|step)','/.test(line)) return;
    steps += 1;
    if (steps === at) show = moving;
  };
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(ma2), showReader(() => show));
  return {
    ma2, bridge,
    /** Counts plugin steps from now; the show turns `to` while step `step` runs. */
    startAt: (step: number | null, to: ShowState = runningShow): void => { steps = 0; at = step; moving = to; },
    stop: (): void => { show = idleShow; at = null; },
    imports: (): string[] => ma2.commands().filter(command => command.startsWith('Import ')),
    object: (): string => ma2.lua(`return FAKE.objects['Timecode 9902'].xml`)[0]!.toString('utf8')
  };
}

async function syncOnce(bridge: Ma2OnpcBridge): Promise<void> {
  const snapshot = await bridge.request('SCOPE', 9902, '9903');
  await bridge.exchange('SYNC', 9902, snapshot, desired);
}

describe('控台同步在一步的边界停下（M3，第 3 题）', () => {
  it('写入那一步的位置和插件一致：SYNC 先做完预检（时间码 1 步 + 每个序列 2 步 + 核对 1 步），再写，最后读回', async () => {
    const { ma2, bridge } = rig();
    const snapshot = await bridge.request('SCOPE', 9902, '9903');
    const before = ma2.perLine.length;
    await bridge.exchange('SYNC', 9902, snapshot, desired);
    const steps = ma2.perLine.slice(before).filter(entry => /','(?:run|step)','/.test(entry.line));
    const write = steps.findIndex(entry => entry.commands.some(command => command.startsWith('Import ')));
    expect(write + 1).toBe(ma2WriteStep('SYNC', snapshot, desired));
    expect(ma2WriteStep('SYNC', snapshot, desired)).toBe(2 * 2 + 3);
    // The read-back is the step right after the write, and the last.
    expect(steps).toHaveLength(write + 2);
  });

  it('预检的每一步之前时间码开始走：这一步做完，下一步不发，马上放掉插件事务，算等待；控台上没有写入（sent: false）', async () => {
    const straight = rig();
    await syncOnce(straight.bridge);
    const writeStep = ma2WriteStep('SYNC', await consoleSnapshot(), desired)!;
    for (let step = 1; step < writeStep; step++) {
      const { ma2, bridge, startAt, stop, imports, object } = rig();
      const snapshot = await bridge.request('SCOPE', 9902, '9903');
      startAt(step);
      const lines = ma2.lines.length;
      const error = await bridge.exchange('SYNC', 9902, snapshot, desired).then(() => null, (cause: unknown) => cause);
      expect(isShowWait(error), `step ${step}`).toBe(true);
      expect(error).toBeInstanceOf(Ma2BridgeFailure);
      expect((error as Ma2BridgeFailure).sent, `step ${step}`).toBe(false);
      expect(error instanceof Error && error.message).toContain('控台上还没有写入');
      expect(imports()).toEqual([]);
      // begin, the chunks and `step` steps; then only the release: no further step went out.
      const sent = ma2.lines.slice(lines);
      expect(sent.filter(line => /','(?:run|step)','/.test(line)), `step ${step}`).toHaveLength(step);
      expect(sent.at(-1)).toContain("','release','");
      // Released at once: a new request starts now, not after the plugin's 120 s expiry. Synced again from the
      // start after the show stops, the console holds what one uninterrupted sync leaves.
      stop();
      await syncOnce(bridge);
      expect(object(), `step ${step}`).toBe(straight.object());
      expect(imports()).toHaveLength(1);
    }
  });

  it('时间码在写入那一步执行时开始走：写入不打断，紧跟的读回照常做完，这次同步确认成功', async () => {
    const straight = rig();
    await syncOnce(straight.bridge);
    const { bridge, startAt, imports, object } = rig();
    const snapshot = await bridge.request('SCOPE', 9902, '9903');
    startAt(ma2WriteStep('SYNC', snapshot, desired));
    const result = await bridge.exchange('SYNC', 9902, snapshot, desired);
    expect(result.response).toContain('time="60"');
    expect(imports()).toHaveLength(1);
    expect(object()).toBe(straight.object());
  });

  it('读取也在一步的边界停下（按 showGate：读取控台在时间码走时等待），已读的步留在控台上不算失败', async () => {
    const { ma2, bridge, startAt } = rig();
    startAt(1);
    const lines = ma2.lines.length;
    const error = await bridge.request('SCOPE', 9902, '9903').then(() => null, (cause: unknown) => cause);
    expect(isShowWait(error)).toBe(true);
    expect(error instanceof Error && error.message).toContain('读到一半停下了');
    const sent = ma2.lines.slice(lines);
    expect(sent.filter(line => /','(?:run|step)','/.test(line))).toHaveLength(1);
    expect(sent.at(-1)).toContain("','release','");
  });

  it('暂停（播完停住、P1 等下一首同理）时照常一步步做完；版本核对任何时候都发', async () => {
    const straight = rig();
    await syncOnce(straight.bridge);
    const paused = rig();
    paused.startAt(1, pausedShow);
    await syncOnce(paused.bridge);
    expect(paused.object()).toBe(straight.object());
    const moving = rig(runningShow);
    await expect(moving.bridge.request('PING', 1)).resolves.toBe('3.3.4.3');
    expect(ma2StepGate('PING')).toBeNull();
  });

  it('一首歌停下等待，不把排在后面的控台操作当成失败取消：后面的自己在一步之前等待', async () => {
    const { bridge, startAt } = rig();
    startAt(1);
    const first = bridge.request('SCOPE', 9902, '9903').then(() => null, (cause: unknown) => cause);
    const queued = bridge.request('READ', 9902).then(() => null, (cause: unknown) => cause);
    expect(isShowWait(await first)).toBe(true);
    const second = await queued;
    expect(isShowWait(second)).toBe(true);
    expect(second instanceof Error && second.message).not.toContain('排队的操作已取消');
  });
});

/** The snapshot SYNC is planned from, read once from a fresh console. */
async function consoleSnapshot(): Promise<string> {
  return rig().bridge.request('SCOPE', 9902, '9903');
}
