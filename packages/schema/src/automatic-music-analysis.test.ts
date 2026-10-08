import { expect, it } from 'vitest';
import { automaticMusicRunSchema, automaticMusicWorkerEventSchema } from './automatic-music-analysis';

function fixture() {
  return { version: 1, run_id: '702ac98c-d085-4b16-942c-997a5d4271a9', engine_fingerprint: 'a'.repeat(64), device: 'cpu',
    audio: { source_sha256: 'b'.repeat(64), pcm_sha256: 'c'.repeat(64), sample_rate: 48000, sample_count: 480000, channels: 2 },
    timings: { total_seconds: 1, decode_seconds: .1, engine_seconds: {}, cached: false },
    diagnostics: { 'silence-guard': { beats: [], downbeats: [], sections: [], events: [] } }, publication: 'not-validated', enabled_capabilities: [] };
}

it('接受严格离线结果，不把研究数据升级为可发布标记', () => {
  expect(automaticMusicRunSchema.parse(fixture()).publication).toBe('not-validated');
  expect(() => automaticMusicRunSchema.parse({ ...fixture(), publication: 'approved' })).toThrow();
  expect(() => automaticMusicRunSchema.parse({ ...fixture(), enabled_capabilities: ['beats'] })).toThrow();
  expect(() => automaticMusicRunSchema.parse({ ...fixture(), credentials: 'unexpected' })).toThrow();
});

it('拒绝半成品模型结果、越界点、非递增拍点和重叠结构', () => {
  const labels = { beats: [1], downbeats: [], sections: [], events: [] };
  const diagnostic = (value: unknown) => ({ ...fixture(), diagnostics: Object.fromEntries(['beat-this-final0', 'beat-this-final1', 'beat-this-final2', 'all-in-one'].map(name => [name, value])) });
  expect(() => automaticMusicRunSchema.parse({ ...fixture(), diagnostics: { 'beat-this-final0': labels } })).toThrow('完整模型');
  expect(automaticMusicRunSchema.parse(diagnostic(labels)).diagnostics['all-in-one']?.beats).toEqual([1]);
  expect(() => automaticMusicRunSchema.parse(diagnostic({ ...labels, beats: [11] }))).toThrow('超出');
  expect(() => automaticMusicRunSchema.parse(diagnostic({ ...labels, beats: [1, 1] }))).toThrow('严格递增');
  expect(() => automaticMusicRunSchema.parse(diagnostic({ ...labels, sections: [{ start: 0, end: 2, label: 'verse' }, { start: 1, end: 3, label: 'chorus' }] }))).toThrow('重叠');
});

it('进程事件限定任务身份、阶段和错误，不接受第三方普通日志作为协议', () => {
  const base = { version: 1, taskId: fixture().run_id };
  expect(automaticMusicWorkerEventSchema.parse({ ...base, type: 'progress', stage: 'verify-assets' }).type).toBe('progress');
  expect(() => automaticMusicWorkerEventSchema.parse({ ...base, type: 'progress', stage: 'download-models' })).toThrow();
  expect(() => automaticMusicWorkerEventSchema.parse({ ...base, type: 'result', result: { ...fixture(), enabled_capabilities: ['drop'] } })).toThrow();
  expect(() => automaticMusicWorkerEventSchema.parse({ ...base, type: 'cancelled', result: fixture() })).toThrow();
});
