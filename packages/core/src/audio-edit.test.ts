import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, referenceAudioSchema } from '@tb/schema';
import { audioSegments, editedAudio, splitAudioSegments, updateAudioSegment } from './audio-edit';
import { AudioBeatDetector } from './audio-beat-detection';
import { editReferenceAudioCommand } from './link-command';

const audio = { assetId: 'song', relativePath: 'assets/music.wav', sha256: 'a'.repeat(64), durationMs: 5000 };
describe('可编辑歌曲音频', () => {
  it('分割保留连续的素材位置与总时长', () => {
    let id = 0;
    const result = splitAudioSegments(audioSegments(audio), [0, 1500, 1500, 3200, 5000], () => `part-${id++}`);
    expect(result.map(({ startMs, sourceOffsetMs, durationMs }) => ({ startMs, sourceOffsetMs, durationMs }))).toEqual([
      { startMs: 0, sourceOffsetMs: 0, durationMs: 1500 }, { startMs: 1500, sourceOffsetMs: 1500, durationMs: 1700 }, { startMs: 3200, sourceOffsetMs: 3200, durationMs: 1800 }
    ]);
    expect(editedAudio(audio, result).sha256).toBe(audio.sha256);
  });
  it('拒绝重叠、负入点、越过源文件结尾', () => {
    const edit = editedAudio(audio, splitAudioSegments(audioSegments(audio), [2000]));
    expect(() => updateAudioSegment(edit, edit.timeline!.segments[1]!.id, { startMs: 1000 })).toThrow();
    expect(() => updateAudioSegment(edit, edit.timeline!.segments[0]!.id, { sourceOffsetMs: -1 })).toThrow();
    expect(() => updateAudioSegment(edit, edit.timeline!.segments[1]!.id, { durationMs: 4000 })).toThrow();
  });
  it('节拍保存不修改歌曲路径和时长，可以撤销', () => {
    const project = createEmptyLinkProject('测试');
    project.rundown.push({ id: 'song', title: '歌曲', enabled: true, notes: '', referenceAudio: audio, visualLayers: [], referenceMediaClips: [], cues: [] });
    const command = editReferenceAudioCommand('song', { ...audio, beats: { sourceSha256: audio.sha256, level: 'standard', pointsMs: [500, 1000] } }, '应用节拍');
    const changed = command.execute(project);
    expect(changed.rundown[0]!.referenceAudio).toMatchObject(audio);
    expect(changed.rundown[0]!.referenceAudio?.beats?.pointsMs).toEqual([500, 1000]);
    expect(command.undo(project)).toEqual(project);
  });
  it('拒绝其他歌曲的节拍缓存和无序标记', () => {
    expect(() => referenceAudioSchema.parse({ ...audio, beats: { sourceSha256: 'b'.repeat(64), level: 'dense', pointsMs: [100] } })).toThrow();
    expect(() => referenceAudioSchema.parse({ ...audio, beats: { sourceSha256: audio.sha256, level: 'dense', pointsMs: [100, 100] } })).toThrow();
  });
});

describe('音频瞬态节拍检测', () => {
  it('密集跟随主拍而不是每个十六分镲片，标准和稀疏按二拍及四拍分层', () => {
    const detector = new AudioBeatDetector();
    for (let sample = 0; sample < 22050 * 12; sample++) {
      const time = sample / 22050;
      const kick = Math.sin(time * Math.PI * 2 * 90) * Math.exp(-(time % 0.5) * 45) * 0.8;
      const hat = Math.sin(time * Math.PI * 2 * 6000) * Math.exp(-(time % 0.125) * 100) * 0.12;
      detector.push(kick + hat);
    }
    const result = detector.finish(12000);
    expect(result.dense.length).toBeGreaterThanOrEqual(20);
    expect(result.dense.length).toBeLessThanOrEqual(25);
    expect(result.dense.every((time) => Math.abs(time - Math.round(time / 500) * 500) < 35)).toBe(true);
    expect(result.standard.length).toBeLessThanOrEqual(13);
    expect(result.sparse.length).toBeLessThanOrEqual(7);
    expect(result.standard.every((time) => result.dense.includes(time))).toBe(true);
    expect(result.sparse.every((time) => result.standard.includes(time))).toBe(true);
  });
  it('静音和稳定正弦不会凭空生成节拍', () => {
    for (const amplitude of [0, 0.5]) {
      const detector = new AudioBeatDetector();
      for (let sample = 0; sample < 22050 * 3; sample++) detector.push(Math.sin(sample * Math.PI * 2 * 440 / 22050) * amplitude);
      expect(detector.finish(3000).dense).toEqual([]);
    }
  });
  it('检测合成鼓点，三级逐渐稀疏且保留真实时间', () => {
    const detector = new AudioBeatDetector();
    for (let sample = 0; sample < 22050 * 6; sample++) {
      const seconds = sample / 22050;
      const beat = Math.floor(seconds / 0.5);
      const local = seconds - beat * 0.5;
      const amplitude = beat % 2 === 0 ? 0.9 : 0.35;
      detector.push(Math.sin(sample * Math.PI * 2 * 100 / 22050) * amplitude * Math.exp(-local * 40));
    }
    const result = detector.finish(6000);
    expect(result.dense.length).toBeGreaterThanOrEqual(10);
    expect(result.dense.every((time) => Math.abs(time - Math.round(time / 500) * 500) < 30)).toBe(true);
    expect(result.standard.every((time) => result.dense.includes(time))).toBe(true);
    expect(result.sparse.every((time) => result.standard.includes(time))).toBe(true);
  });
});
