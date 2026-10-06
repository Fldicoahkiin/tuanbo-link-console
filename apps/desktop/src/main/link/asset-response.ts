import { open } from 'node:fs/promises';

const CHUNK_BYTES = 64 * 1024;

/** Range requests may span hours of media. Only read the next requested chunk;
 * closing a preview cancels the stream and releases the file handle. */
export async function assetResponse(path: string, request: Request, contentType: string): Promise<Response> {
  const file = await open(path, 'r');
  let closing: Promise<void> | undefined;
  let abort: (() => void) | undefined;
  const close = (): Promise<void> => {
    if (abort) request.signal.removeEventListener('abort', abort);
    return closing ??= file.close();
  };
  try {
    const { size } = await file.stat();
    const range = request.headers.get('range');
    const headers = { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const bounds = range ? parseByteRange(range, size) : { start: 0, end: size - 1 };
    if (!bounds) {
      await close();
      return new Response('Invalid byte range', { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    const length = bounds.end - bounds.start + 1;
    const responseHeaders = { ...headers, 'Content-Length': String(length), ...(range ? { 'Content-Range': `bytes ${bounds.start}-${bounds.end}/${size}` } : {}) };
    if (request.method === 'HEAD' || length === 0) { await close(); return new Response(null, { status: range ? 206 : 200, headers: responseHeaders }); }
    let position = bounds.start, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abort = () => {
          cancelled = true;
          void close().then(() => controller.error(new Error('素材读取已取消')), error => controller.error(error));
        };
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
      },
      async pull(controller) {
        try {
          if (request.signal.aborted) throw new Error('素材读取已取消');
          const chunk = new Uint8Array(Math.min(CHUNK_BYTES, bounds.end - position + 1));
          const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
          if (cancelled) return;
          if (!bytesRead) throw new Error('素材读取提前结束：文件可能已被修改');
          position += bytesRead;
          controller.enqueue(chunk.subarray(0, bytesRead));
          if (position > bounds.end) { await close(); controller.close(); }
        } catch (error) { await close(); if (!cancelled) controller.error(error); }
      },
      async cancel() { cancelled = true; await close(); }
    }, { highWaterMark: 0 });
    return new Response(body, { status: range ? 206 : 200, headers: responseHeaders });
  } catch (error) { await close(); throw error; }
}

function parseByteRange(value: string, size: number): { start: number; end: number } | null {
  if (!size) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const startText = match[1] ?? '', endText = match[2] ?? '';
  if (!startText && !endText) return null;
  if (!startText) {
    const suffix = Number(endText);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(startText), end = endText ? Number(endText) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start < size && end >= start
    ? { start, end: Math.min(end, size - 1) } : null;
}
