import { describe, expect, it } from 'vitest';
import {
  linkExternalApplicationIdSchema,
  linkLogFilterSchema,
  linkLogRecordSchema,
  linkMediaAssetImportPayloadSchema,
  linkObsSourcePreviewPayloadSchema,
  linkProjectNameSchema,
  linkReferenceAudioImportPayloadSchema,
  linkRuntimeActiveSchema,
  linkWaveformCacheSavePayloadSchema,
  linkWaveformGeneratePayloadSchema
} from './link-ipc';

describe('联动台 IPC Zod 契约', () => {
  it('波形生成只接收应用素材令牌和有界时长', () => {
    const payload = { projectPath: 'C:/Shows/show.tblink', sha256: 'a'.repeat(64), url: 'tblink-asset://local/12345678-abcd-4321-abcd-123456789abc', durationMs: 3605000 };
    expect(linkWaveformGeneratePayloadSchema.parse(payload)).toEqual(payload);
    for (const url of ['https://example.com/audio.wav', 'file:///C:/audio.wav', 'tblink-asset://remote/abc']) expect(linkWaveformGeneratePayloadSchema.safeParse({ ...payload, url }).success).toBe(false);
    for (const durationMs of [0, -1, Infinity, 86400001]) expect(linkWaveformGeneratePayloadSchema.safeParse({ ...payload, durationMs }).success).toBe(false);
  });
  it('接受完整的受支持参数', () => {
    expect(linkExternalApplicationIdSchema.parse('p1')).toBe('p1');
    expect(linkProjectNameSchema.parse('  现场工程  ')).toBe('现场工程');
    expect(linkRuntimeActiveSchema.parse(true)).toBe(true);
    expect(linkReferenceAudioImportPayloadSchema.parse({
      projectPath: 'C:\\Shows\\show.tblink',
      sourcePath: 'C:\\Media\\song.wav',
      durationMs: 1_000
    })).toMatchObject({ durationMs: 1_000 });
    expect(linkMediaAssetImportPayloadSchema.parse({
      projectPath: 'C:\\Shows\\show.tblink',
      sourcePath: 'C:\\Media\\opening.mp4',
      name: '开场视频',
      kind: 'video',
      durationMs: 5_000,
      width: 1_920,
      height: 1_080
    })).toMatchObject({ kind: 'video', width: 1_920 });
    expect(linkLogRecordSchema.parse({
      level: 'info',
      category: 'device',
      message: 'P1 running',
      device: 'p1',
      details: { pid: 100 }
    })).toMatchObject({ device: 'p1' });
    expect(linkLogFilterSchema.parse({ result: 'failed' })).toEqual({ result: 'failed' });
    expect(linkObsSourcePreviewPayloadSchema.parse({ sourceName: 'Camera', width: 8, height: 8 })).toEqual({ sourceName: 'Camera', width: 8, height: 8 });
    expect(linkObsSourcePreviewPayloadSchema.parse({ sourceName: 'Camera' })).toEqual({ sourceName: 'Camera' });
  });

  it('窗口日志单条有长度上限：消息 8192 字、ID 256 字、详情序列化后 256 KB', () => {
    const entry = { level: 'error' as const, category: 'system' as const, message: 'x'.repeat(8192), device: 'd'.repeat(256), details: { stack: '\n'.repeat(32768), componentStack: '\n'.repeat(32768) } };
    expect(linkLogRecordSchema.parse(entry)).toMatchObject({ device: entry.device });
    expect(() => linkLogRecordSchema.parse({ ...entry, message: 'x'.repeat(8193) })).toThrow();
    expect(() => linkLogRecordSchema.parse({ ...entry, device: 'd'.repeat(257) })).toThrow();
    expect(() => linkLogRecordSchema.parse({ ...entry, projectId: 'p'.repeat(257) })).toThrow();
    expect(() => linkLogRecordSchema.parse({ ...entry, details: { stack: 's'.repeat(262_144) } })).toThrow('日志详情超过 256 KB');
  });

  it('拒绝越界 ID、空消息和无效波形数据', () => {
    expect(() => linkExternalApplicationIdSchema.parse('program')).toThrow();
    expect(() => linkExternalApplicationIdSchema.parse('liveCompanion')).toThrow();
    expect(() => linkObsSourcePreviewPayloadSchema.parse({ sourceName: 'Camera', width: 1, height: 8 })).toThrow();
    expect(() => linkObsSourcePreviewPayloadSchema.parse({ sourceName: 'Camera', width: 960 })).toThrow('同时提供或同时省略');
    expect(() => linkLogRecordSchema.parse({ level: 'info', category: 'system', message: '' })).toThrow();
    expect(() => linkWaveformCacheSavePayloadSchema.parse({
      projectPath: 'C:\\Shows\\show.tblink',
      sha256: 'a'.repeat(64),
      peaks: [1.1]
    })).toThrow();
    expect(() => linkMediaAssetImportPayloadSchema.parse({
      projectPath: 'C:\\Shows\\show.tblink',
      sourcePath: 'C:\\Media\\opening.exe',
      name: '',
      kind: 'program'
    })).toThrow();
  });
});
