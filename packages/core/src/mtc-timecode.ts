import type { MtcFrameRate, SmpteTimecode } from '@tb/schema';

export type MtcDirection = 'forward' | 'reverse';

export type MtcSample = {
  frameRate: MtcFrameRate;
  timecode: SmpteTimecode;
  totalFrames: number;
  receivedAtMs: number;
  direction: MtcDirection;
};

const RATE_BY_CODE: readonly MtcFrameRate[] = ['24', '25', '29.97df', '30'];

/** A whole quarter-frame cycle that makes no timecode (pieces of two positions when the sender relocated mid-cycle can
 * give seconds over 59 and the like). Told apart by its type, never by its text. */
export class MtcDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MtcDecodeError';
  }
}

export class MtcQuarterFrameDecoder {
  private readonly pieces: Array<number | undefined> = new Array<number | undefined>(8);
  private lastType: number | null = null;
  private direction: MtcDirection | null = null;

  push(dataByte: number, receivedAtMs: number): MtcSample | null {
    if (!Number.isInteger(dataByte) || dataByte < 0 || dataByte > 0x7f) {
      throw new Error(`无效的 MTC quarter-frame 数据：${dataByte}`);
    }
    const type = (dataByte >> 4) & 0x07;
    const value = dataByte & 0x0f;
    const nextDirection = this.resolveDirection(type);
    if (this.direction && nextDirection && this.direction !== nextDirection) this.clearPieces();
    if (nextDirection) this.direction = nextDirection;
    this.pieces[type] = value;
    this.lastType = type;

    const cycleComplete = this.direction === 'forward' ? type === 7 : this.direction === 'reverse' && type === 0;
    if (!cycleComplete || this.pieces.some((piece) => piece === undefined) || !this.direction) return null;

    const decoded = this.decode(receivedAtMs, this.direction);
    this.clearPieces();
    return decoded;
  }

  reset(): void {
    this.clearPieces();
    this.lastType = null;
    this.direction = null;
  }

  private resolveDirection(type: number): MtcDirection | null {
    if (this.lastType === null) return null;
    const delta = (type - this.lastType + 8) % 8;
    if (delta === 1) return 'forward';
    if (delta === 7) return 'reverse';
    this.clearPieces();
    this.direction = null;
    return null;
  }

  private decode(receivedAtMs: number, direction: MtcDirection): MtcSample {
    const piece = (index: number): number => this.pieces[index] ?? 0;
    const frameRate = RATE_BY_CODE[(piece(7) >> 1) & 0x03];
    if (!frameRate) throw new MtcDecodeError('MTC 帧率编码无效');
    const timecode: SmpteTimecode = {
      hours: piece(6) | ((piece(7) & 0x01) << 4),
      minutes: piece(4) | ((piece(5) & 0x03) << 4),
      seconds: piece(2) | ((piece(3) & 0x03) << 4),
      frames: piece(0) | ((piece(1) & 0x01) << 4)
    };
    assertDecodedTimecode(timecode, frameRate);
    const rawFrames = timecodeToFrameNumber(timecode, frameRate);
    const compensated = direction === 'forward' ? rawFrames + 2 : rawFrames - 2;
    const totalFrames = wrapFrameNumber(compensated, frameRate);
    return {
      frameRate,
      timecode: frameNumberToTimecode(totalFrames, frameRate),
      totalFrames,
      receivedAtMs,
      direction
    };
  }

  private clearPieces(): void {
    this.pieces.fill(undefined);
  }
}

function assertDecodedTimecode(timecode: SmpteTimecode, frameRate: MtcFrameRate): void {
  const maximumFrame = nominalFramesPerSecond(frameRate) - 1;
  const invalidRange = timecode.hours > 23
    || timecode.minutes > 59
    || timecode.seconds > 59
    || timecode.frames > maximumFrame;
  const invalidDropFrame = frameRate === '29.97df'
    && timecode.seconds === 0
    && timecode.minutes % 10 !== 0
    && timecode.frames < 2;
  if (invalidRange || invalidDropFrame) {
    const value = [timecode.hours, timecode.minutes, timecode.seconds, timecode.frames]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
    throw new MtcDecodeError(`MTC quarter-frame 解码出无效时间码：${value} @ ${frameRate}`);
  }
}

export function nominalFramesPerSecond(frameRate: MtcFrameRate): number {
  if (frameRate === '24') return 24;
  if (frameRate === '25') return 25;
  return 30;
}

export function playbackFramesPerSecond(frameRate: MtcFrameRate): number {
  return frameRate === '29.97df' ? 30_000 / 1_001 : nominalFramesPerSecond(frameRate);
}

export function millisecondsToFrameNumber(milliseconds: number, frameRate: MtcFrameRate): number {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('时间必须是非负有限毫秒数');
  return Math.round(milliseconds / 1_000 * playbackFramesPerSecond(frameRate));
}

export function timecodeToMilliseconds(timecode: SmpteTimecode, frameRate: MtcFrameRate): number {
  return timecodeToFrameNumber(timecode, frameRate) / playbackFramesPerSecond(frameRate) * 1_000;
}

export function parseMtcOffset(text: string, frameRate: MtcFrameRate): number {
  if (!/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(text)) throw new Error('请按 时:分:秒:帧 输入，例如 01:00:00:15');
  const parts = text.split(':').map(Number);
  const tc = { hours: parts[0]!, minutes: parts[1]!, seconds: parts[2]!, frames: parts[3]! };
  const fps = nominalFramesPerSecond(frameRate);
  if (tc.hours > 23 || tc.minutes > 59 || tc.seconds > 59 || tc.frames >= fps) throw new Error(`时为 00–23，分和秒为 00–59，当前帧率的帧数为 00–${fps - 1}`);
  if (frameRate === '29.97df' && tc.minutes % 10 !== 0 && tc.seconds === 0 && tc.frames < 2) throw new Error('29.97 DF 非整十分钟的整分钟处从 02 帧开始');
  // Persist whole milliseconds on or after the requested frame boundary, so the
  // MIDI encoder's floor never emits the preceding frame after saving.
  return Math.ceil(timecodeToMilliseconds(tc, frameRate));
}

export function formatMtcOffset(milliseconds: number, frameRate: MtcFrameRate): string {
  const tc = frameNumberToTimecode(millisecondsToFrameNumber(milliseconds, frameRate), frameRate);
  return [tc.hours, tc.minutes, tc.seconds, tc.frames].map((part) => String(part).padStart(2, '0')).join(':');
}

export function timecodeToFrameNumber(timecode: SmpteTimecode, frameRate: MtcFrameRate): number {
  const fps = nominalFramesPerSecond(frameRate);
  const nominal = (((timecode.hours * 60 + timecode.minutes) * 60 + timecode.seconds) * fps) + timecode.frames;
  if (frameRate !== '29.97df') return nominal;
  const totalMinutes = timecode.hours * 60 + timecode.minutes;
  return nominal - 2 * (totalMinutes - Math.floor(totalMinutes / 10));
}

export function frameNumberToTimecode(frameNumber: number, frameRate: MtcFrameRate): SmpteTimecode {
  const wrapped = wrapFrameNumber(frameNumber, frameRate);
  const fps = nominalFramesPerSecond(frameRate);
  let nominalFrames = wrapped;
  if (frameRate === '29.97df') {
    const tenMinuteBlocks = Math.floor(wrapped / 17_982);
    const remainder = wrapped % 17_982;
    nominalFrames += 18 * tenMinuteBlocks;
    if (remainder >= 2) nominalFrames += 2 * Math.floor((remainder - 2) / 1_798);
  }
  const hours = Math.floor(nominalFrames / (fps * 3600));
  const minutes = Math.floor(nominalFrames / (fps * 60)) % 60;
  const seconds = Math.floor(nominalFrames / fps) % 60;
  const frames = nominalFrames % fps;
  return { hours, minutes, seconds, frames };
}

function wrapFrameNumber(frameNumber: number, frameRate: MtcFrameRate): number {
  const framesPerDay = frameRate === '29.97df'
    ? 2_589_408
    : nominalFramesPerSecond(frameRate) * 86_400;
  return ((frameNumber % framesPerDay) + framesPerDay) % framesPerDay;
}
