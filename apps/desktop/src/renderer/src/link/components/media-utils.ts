import type { LinkMediaKind, ReferenceMediaClip } from '@tb/schema';

export async function readMediaMetadata(file: File): Promise<{
  kind: LinkMediaKind;
  durationMs?: number;
  width?: number;
  height?: number;
}> {
  const kind = detectMediaKind(file);
  if (kind === 'image') return { kind, ...await readImageDimensions(file) };
  return { kind, ...await readTimedMediaMetadata(file, kind) };
}

export function formatTimecode(value: ReferenceMediaClip['startTimecode']): string {
  return [value.hours, value.minutes, value.seconds, value.frames]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function formatMilliseconds(milliseconds: number): string {
  const rounded = Math.max(0, Math.round(milliseconds));
  const totalSeconds = Math.floor(rounded / 1_000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}.${String(rounded % 1_000).padStart(3, '0')}`;
}

export function formatBytes(value: number): string {
  return value >= 1_048_576
    ? `${(value / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1_024))} KB`;
}

export function detectMediaKind(file: File): LinkMediaKind {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'].includes(extension)) return 'video';
  if (['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg'].includes(extension)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(extension)) return 'image';
  throw new Error('无法识别媒体类型');
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    image.onload = () => { cleanup(); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { cleanup(); reject(new Error('图片无法解码')); };
    image.src = url;
  });
}

function readTimedMediaMetadata(file: File, kind: 'audio' | 'video'): Promise<{
  durationMs: number;
  width?: number;
  height?: number;
}> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(kind);
    const cleanup = () => { element.removeAttribute('src'); URL.revokeObjectURL(url); };
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const durationMs = Math.round(element.duration * 1_000);
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        cleanup();
        reject(new Error('无法读取媒体时长'));
        return;
      }
      if (kind === 'video') {
        const video = element as HTMLVideoElement;
        const result = { durationMs, width: video.videoWidth, height: video.videoHeight };
        cleanup();
        resolve(result);
        return;
      }
      cleanup();
      resolve({ durationMs });
    };
    element.onerror = () => { cleanup(); reject(new Error(`${kind === 'video' ? '视频' : '音频'}无法解码`)); };
    element.src = url;
  });
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

