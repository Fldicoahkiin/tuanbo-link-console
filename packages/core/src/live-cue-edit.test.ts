import { expect, it } from 'vitest';
import { parseLinkProject, type LinkCue, type LiveCueEditRequest } from '@tb/schema';
import { CueRuntime } from './cue-runtime';
import { frameNumberToTimecode } from './mtc-timecode';

function cue(id: string, seconds: number): LinkCue {
  return { id, name: id, timecode: frameNumberToTimecode(seconds * 30, '30'), enabled: true, notes: '',
    actions: [{ id: `${id}-action`, label: '验收机位', kind: 'obs.setProgramScene', sceneName: '验收场景' }] };
}
function fixture(): CueRuntime {
  const runtime = new CueRuntime(parseLinkProject({ schemaVersion: 1, projectId: 'project', name: '测试',
    createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', playbackSource: 'internal',
    timebase: { frameRate: '30', mode: 'per-item-reset' }, rundown: [{ id: 'program', title: '歌曲', cues: [cue('past', 1), cue('future', 20)] }] }));
  runtime.selectItem('program'); runtime.beginPreflight('live'); runtime.arm(0); advance(runtime, 0, 0); return runtime;
}
function request(runtime: CueRuntime, cues: LinkCue[], transactionId = 'edit'): LiveCueEditRequest {
  const context = runtime.getCueEditContext(); if (!context) throw new Error('缺少测试会话');
  return { ...context, version: 1, transactionId, cues };
}
function commit(runtime: CueRuntime, value: LiveCueEditRequest, ready = true) {
  const { cues: _cues, ...identity } = value; void _cues;
  return runtime.commitCueEdit({ ...identity, channels: [{ channel: 'obs', state: ready ? 'ready' : 'failed' }] });
}
function advance(runtime: CueRuntime, from: number, through: number): string[] {
  const fired: string[] = [];
  for (let frame = from; frame <= through; frame++) {
    const result = runtime.ingest({ frameRate: '30', timecode: frameNumberToTimecode(frame, '30'), totalFrames: frame, receivedAtMs: frame * 1000 / 30, direction: 'forward' });
    expect(result.state).toBe('running'); fired.push(...result.dueCues.map(entry => entry.cue.id));
  }
  return fired;
}

it('未来移动在通道准备后本轮生效，不重播过去，也不在新旧位置各执行一次', () => {
  const runtime = fixture(); expect(advance(runtime, 1, 150)).toEqual(['past']);
  const next = request(runtime, [cue('past', 1), cue('future', 30)]);
  expect(runtime.prepareCueEdit(next)).toMatchObject({ status: 'awaiting-preparation', requiredChannels: ['obs'] });
  expect(commit(runtime, next)).toEqual({ status: 'applied', revision: 1 });
  expect(advance(runtime, 151, 600)).toEqual([]);
  expect(advance(runtime, 601, 900)).toEqual(['future']);
  expect(advance(runtime, 901, 930)).toEqual([]);
});
it('异步准备超过保护边界、通道失败或缺确认时，保留原执行版本', () => {
  for (const mode of ['late', 'failed', 'missing'] as const) {
    const runtime = fixture(), next = request(runtime, [cue('past', 1), cue('future', 30)]);
    expect(runtime.prepareCueEdit(next).status).toBe('awaiting-preparation');
    const frame = mode === 'late' ? 450 : 0;
    if (frame) advance(runtime, 1, frame);
    const { cues: _cues, ...identity } = next; void _cues;
    const result = mode === 'missing' ? runtime.commitCueEdit({ ...identity, channels: [] }) : commit(runtime, next, mode !== 'failed');
    expect(result.status).toBe('not-applied');
    expect(advance(runtime, frame + 1, 900).filter(id => id === 'future')).toEqual(['future']);
  }
});
it('过去移到未来、未来移入保护窗口、已执行动作均不能补发', () => {
  for (const cues of [[cue('past', 30), cue('future', 20)], [cue('past', 1), cue('future', 10)]]) {
    const runtime = fixture(); advance(runtime, 1, 150);
    expect(runtime.prepareCueEdit(request(runtime, cues)).status).toBe('not-applied');
    expect(advance(runtime, 151, 1000)).toEqual(['future']);
  }
});
it('撤销形成新事务；旧准备、旧版本及暂停前确认均不能覆盖新状态', () => {
  const runtime = fixture(), moved = request(runtime, [cue('past', 1), cue('future', 30)], 'move');
  runtime.prepareCueEdit(moved); expect(commit(runtime, moved).status).toBe('applied');
  const undo = request(runtime, [cue('past', 1), cue('future', 20)], 'undo');
  runtime.prepareCueEdit(undo);
  expect(runtime.prepareCueEdit(moved).status).toBe('not-applied');
  expect(commit(runtime, undo).status).toBe('applied');
  const later = request(runtime, [cue('past', 1), cue('future', 40)], 'later'); runtime.prepareCueEdit(later);
  runtime.pauseAutomatic(); runtime.resumeAutomatic();
  expect(commit(runtime, later).status).toBe('not-applied');
  expect(advance(runtime, 1, 1200)).toEqual(['past', 'future']);
});
it('未来删除与新增只改变未执行计划；编译仍拒绝不存在的图层', () => {
  const runtime = fixture(), next = request(runtime, [cue('past', 1), cue('new', 25)]);
  runtime.prepareCueEdit(next); expect(commit(runtime, next).status).toBe('applied');
  expect(advance(runtime, 1, 1000)).toEqual(['past', 'new']);
  const invalid = request(runtime, [{ ...cue('bad-layer', 40), layerId: 'not-found' }]);
  expect(() => runtime.prepareCueEdit(invalid)).toThrow('不存在的图层');
});
