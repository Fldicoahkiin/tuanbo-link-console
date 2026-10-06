import { mkdtemp, writeFile, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { assetResponse } from './asset-response';

const request = (range?: string, signal?: AbortSignal): Request => new Request('https://local.test/media', { headers: range ? { range } : {}, ...(signal ? { signal } : {}) });

describe('bounded asset streaming', () => {
  test('streams a large open range without allocating its complete size, and cancellation closes it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-stream-')), path = join(directory, 'large.wav');
    const file = await open(path, 'w');
    await file.truncate(1024 * 1024 * 1024); await file.close();
    const response = await assetResponse(path, request('bytes=0-'), 'audio/wav');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-length')).toBe('1073741824');
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(65536);
    await reader.cancel();
    // Windows also exercises handle release rather than just a JS state flag.
    await rename(path, join(directory, 'cancelled.wav'));
    await writeFile(join(directory, 'cancelled.wav'), '');
  });
  test('preserves exact range bytes and rejects invalid/empty ranges', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-range-')), path = join(directory, 'audio.wav');
    const data = Buffer.from(Array.from({ length: 150001 }, (_, index) => index % 251));
    await writeFile(path, data);
    for (const [range, start, end] of [['bytes=65000-131077', 65000, 131078], ['bytes=-17', 149984, 150001], ['bytes=149990-', 149990, 150001]] as const) {
      const result = await assetResponse(path, request(range), 'audio/wav');
      expect(Buffer.from(await result.arrayBuffer())).toEqual(data.subarray(start, end));
    }
    for (const range of ['bytes=150001-', 'bytes=3-1', 'bytes=-', 'bytes=0-1,4-9', 'bytes=9007199254740992-']) {
      expect((await assetResponse(path, request(range), 'audio/wav')).status).toBe(416);
    }
    await writeFile(path, '');
    expect((await assetResponse(path, request('bytes=-1'), 'audio/wav')).status).toBe(416);
    expect((await assetResponse(path, request(), 'audio/wav')).headers.get('content-length')).toBe('0');
  });
  test('aborting before consumption and truncation during playback report errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-abort-')), path = join(directory, 'audio.wav');
    await writeFile(path, Buffer.alloc(150001));
    const abort = new AbortController();
    const response = await assetResponse(path, request(undefined, abort.signal), 'audio/wav');
    abort.abort();
    await expect(response.arrayBuffer()).rejects.toThrow('取消');
    const truncated = await assetResponse(path, request(), 'audio/wav');
    await writeFile(path, '');
    await expect(truncated.arrayBuffer()).rejects.toThrow('提前结束');
  });
});
