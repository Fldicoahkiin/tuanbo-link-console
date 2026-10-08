import { expect, it } from 'vitest';
import { automaticMusicRunSchema, createLightingDocument, parseLinkProject, createEmptyLinkProject } from '@tb/schema';
import { automaticMusicCandidates, applyAutomaticMusicCandidates, removeAutomaticMusicAnnotations } from './automatic-music-candidates';
import { setLightingCommand } from './lighting-edit';

function fixture() {
  const source = { assetId: 'audio', relativePath: 'song.wav', durationMs: 3000, sha256: 'b'.repeat(64) };
  const labels = { beats: [.5, 1, 1.5, 2], downbeats: [.5], sections: [], events: [] };
  const run = automaticMusicRunSchema.parse({ version: 1, run_id: crypto.randomUUID(), engine_fingerprint: 'a'.repeat(64), device: 'cpu', audio: { source_sha256: source.sha256, pcm_sha256: 'c'.repeat(64), sample_rate: 48000, sample_count: 144000, channels: 2 }, timings: { total_seconds: 1, decode_seconds: .1, engine_seconds: {}, cached: false }, publication: 'not-validated', enabled_capabilities: [], diagnostics: { 'beat-this-final0': labels, 'beat-this-final1': labels, 'beat-this-final2': labels, 'all-in-one': { ...labels, sections: [{ start: 0, end: 3, label: 'verse' }] } } });
  return { source, run, document: createLightingDocument(), candidates: automaticMusicCandidates(run) };
}

it('删除仅针对当前音源，单项和整批清除保留手工内容、其他音源与灯光', () => {
  const f = fixture();
  const applied = applyAutomaticMusicCandidates(f.document, f.source, f.candidates, new Set(f.candidates.items.map(item => item.id)));
  const extra = [ { ...applied.markers[0]!, id: 'manual' }, { ...applied.markers[0]!, id: `analysis:${'c'.repeat(64)}:beat:1` } ];
  const document = { ...applied, markers: [...applied.markers, ...extra] };
  const removed = removeAutomaticMusicAnnotations(document, f.source.sha256, new Set([applied.markers[0]!.id]));
  expect(removed.markers).toHaveLength(document.markers.length - 1);
  expect(removed.music).toEqual(document.music);
  const cleared = removeAutomaticMusicAnnotations(document, f.source.sha256);
  expect(cleared.markers).toEqual(extra); expect(cleared.music?.sections).toEqual([]);
  expect(cleared.tracks).toEqual(document.tracks);
});

it('完整结果提供有位置的候选和 BPM，不伪造灯光事件', () => {
  const f = fixture();
  expect(f.candidates.bpm).toBe(120); expect(f.candidates.items).toHaveLength(6);
  expect(f.candidates.items.find(item => item.kind === 'section')).toMatchObject({ name: '主歌 1', startMs: 0, endMs: 3000 });
  const next = applyAutomaticMusicCandidates(f.document, f.source, f.candidates, new Set(f.candidates.items.map(item => item.id)));
  expect(next.markers).toHaveLength(5); expect(next.music?.sections).toHaveLength(1);
  expect(next.tracks).toEqual(f.document.tracks); expect(next.tempos).toEqual(f.document.tempos);
  expect(f.document.markers).toEqual([]);
  expect(applyAutomaticMusicCandidates(next, f.source, f.candidates, new Set(f.candidates.items.map(item => item.id)))).toEqual(next);
});

it('换音源、改裁剪、越界和段落冲突拒绝整批应用', () => {
  const f = fixture(); const selected = new Set(f.candidates.items.map(item => item.id));
  expect(() => applyAutomaticMusicCandidates(f.document, { ...f.source, sha256: 'd'.repeat(64) }, f.candidates, selected)).toThrow('音源');
  expect(() => applyAutomaticMusicCandidates(f.document, { ...f.source, durationMs: 2000 }, f.candidates, selected)).toThrow('裁剪');
  expect(() => applyAutomaticMusicCandidates(f.document, f.source, { ...f.candidates, items: [{ id: 'bad', kind: 'beat', name: 'bad', startMs: 4000, endMs: null }] }, new Set(['bad']))).toThrow('范围');
  const first = applyAutomaticMusicCandidates(f.document, f.source, f.candidates, selected);
  const manual = { ...first, music: { ...first.music!, sections: first.music!.sections.map(item => ({ ...item, id: 'manual' })) } };
  expect(() => applyAutomaticMusicCandidates(manual, f.source, f.candidates, selected)).toThrow('重叠');
  expect(manual.music.sections[0]?.id).toBe('manual');
});

it('应用通过单笔命令保存，撤销整体恢复，重开保留结果', () => {
  const f = fixture(); const before = parseLinkProject({ ...createEmptyLinkProject('分析结果'), schemaVersion: 2, rundown: [{ id: 'song', title: 'song', referenceAudio: f.source, lighting: f.document }] });
  const next = applyAutomaticMusicCandidates(f.document, f.source, f.candidates, new Set(f.candidates.items.map(item => item.id)));
  const command = setLightingCommand('song', next, '应用音乐分析结果'); const saved = command.execute(before);
  expect(parseLinkProject(JSON.parse(JSON.stringify(saved))).rundown[0]?.lighting?.markers).toHaveLength(5);
  expect(command.undo(before)).toEqual(before);
});
