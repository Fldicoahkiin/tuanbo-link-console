/**
 * How bad an output failure is (0.5.9 design 01 §4.5, design 00 §2 item 8). Every
 * output shares one failure shape:
 * - `channel`: the whole path is broken (OBS connection, audio device, MIDI port, MA2 link): it stops;
 * - `item`: only this one request, message or clip: it is marked red, the rest goes on;
 * - `waiting`: not a failure (not connected yet, reconnecting, preparing, timecode lost).
 * What follows depends on the mode: in a rehearsal the first failure holds every
 * later action and nothing is repaired (AGENTS §4.8 as it stands); live, a failure
 * is marked red and playback goes on.
 */

export type OutputMode = 'rehearsal' | 'live';
export type OutputChannel = 'obs' | 'audio' | 'mtc' | 'actionMidi' | 'ma2';

export type ChannelFailureKind =
  | 'obs-disconnected' | 'obs-unanswered' | 'obs-owned-scene-missing'
  | 'audio-device-invalidated' | 'audio-device-failed'
  | 'midi-port-gone' | 'midi-driver-unresponsive' | 'midi-port-busy' | 'midi-process-exited' | 'midi-failed'
  | 'ma2-disconnected';
export type ItemFailureKind =
  | 'obs-request-rejected' | 'obs-request-not-sent' | 'picture-not-aligned' | 'media-prepare-failed'
  | 'midi-message-late' | 'midi-message-invalid'
  | 'audio-underrun' | 'audio-clock-skew' | 'audio-read-failed'
  | 'mtc-send-failed';
export type WaitingKind = 'not-connected' | 'reconnecting' | 'preparing' | 'timecode-lost' | 'revision-preparing' | 'superseded' | 'taken-over';

export type OutputFailure =
  | { scope: 'channel'; channel: OutputChannel; kind: ChannelFailureKind; detail: string }
  | { scope: 'item'; channel: OutputChannel; item: string; kind: ItemFailureKind; detail: string }
  | { scope: 'waiting'; channel: OutputChannel; kind: WaitingKind; detail: string };

/** What an OBS request came back with, as the executor reports it. */
export type ObsFailureSignal =
  | { kind: 'not-connected' }
  | { kind: 'disconnected'; detail: string }
  /** A request that went out had no answer for the whole limit: the connection is dropped. */
  | { kind: 'unanswered'; label: string }
  /** Waited in the queue for the whole limit without being sent: only this request. */
  | { kind: 'queue-timeout'; label: string }
  | { kind: 'rejected'; label: string; detail: string }
  /** The request was outdated before it went out. */
  | { kind: 'superseded'; label: string }
  | { kind: 'owned-scene-missing'; sceneName: string; detail: string };

export function classifyObsFailure(signal: ObsFailureSignal, item: string): OutputFailure {
  switch (signal.kind) {
    case 'not-connected': return { scope: 'waiting', channel: 'obs', kind: 'not-connected', detail: 'OBS 还没连接' };
    case 'disconnected': return { scope: 'channel', channel: 'obs', kind: 'obs-disconnected', detail: signal.detail };
    case 'unanswered': return { scope: 'channel', channel: 'obs', kind: 'obs-unanswered', detail: `OBS 没有回应「${signal.label}」` };
    case 'queue-timeout': return { scope: 'item', channel: 'obs', item, kind: 'obs-request-not-sent', detail: `OBS 太忙，「${signal.label}」没来得及发出` };
    case 'rejected': return { scope: 'item', channel: 'obs', item, kind: 'obs-request-rejected', detail: `OBS 拒绝了「${signal.label}」：${signal.detail}` };
    case 'superseded': return { scope: 'waiting', channel: 'obs', kind: 'superseded', detail: `「${signal.label}」已过时，没有发送` };
    case 'owned-scene-missing': return { scope: 'channel', channel: 'obs', kind: 'obs-owned-scene-missing', detail: signal.detail };
  }
}

/** Native MIDI result codes (TBM1 and the playback engine): -7 expired, -6 SysEx still
 * sending, -1 invalid message only lose this message; 5/6 interface gone, -2 no such port,
 * -4 driver not responding, 4/7 port busy and anything unknown stop the path. */
export function classifyMidiCode(code: number): 'ok' | 'message' | 'channel' {
  if (code === 0) return 'ok';
  return code === -7 || code === -6 || code === -1 ? 'message' : 'channel';
}

export function midiCodeFailure(code: number, channel: 'mtc' | 'actionMidi', item: string, detail: string): OutputFailure | null {
  const level = classifyMidiCode(code);
  if (level === 'ok') return null;
  if (level === 'message') return channel === 'mtc'
    ? { scope: 'item', channel, item, kind: 'mtc-send-failed', detail }
    : { scope: 'item', channel, item, kind: code === -1 ? 'midi-message-invalid' : 'midi-message-late', detail };
  const kind: ChannelFailureKind = code === 5 || code === 6 || code === -2 ? 'midi-port-gone'
    : code === -4 ? 'midi-driver-unresponsive' : code === 4 || code === 7 ? 'midi-port-busy' : 'midi-failed';
  return { scope: 'channel', channel, kind, detail };
}

/** HRESULTs the playback engine reports in `audioError` (signed 32 bit). */
export const AUDIO_HRESULT = {
  bufferError: 0x88890018 | 0,          // AUDCLNT_E_BUFFER_ERROR: one underrun
  deviceInvalidated: 0x88890004 | 0,    // AUDCLNT_E_DEVICE_INVALIDATED: the device is gone
  timeSkew: 0x80070576 | 0,             // HRESULT_FROM_WIN32(ERROR_TIME_SKEW): one bad clock reading
  readFault: 0x8007001e | 0             // HRESULT_FROM_WIN32(ERROR_READ_FAULT): one failed file read
} as const;

/** One underrun, one bad clock reading or one failed read is this moment only; a
 * device that is gone, or anything else, stops the song's audio. */
export function classifyAudioError(code: number, item: string, detail: string): OutputFailure | null {
  const signed = code | 0;
  if (signed === 0) return null;
  if (signed === AUDIO_HRESULT.bufferError) return { scope: 'item', channel: 'audio', item, kind: 'audio-underrun', detail };
  if (signed === AUDIO_HRESULT.timeSkew) return { scope: 'item', channel: 'audio', item, kind: 'audio-clock-skew', detail };
  if (signed === AUDIO_HRESULT.readFault) return { scope: 'item', channel: 'audio', item, kind: 'audio-read-failed', detail };
  return { scope: 'channel', channel: 'audio', kind: signed === AUDIO_HRESULT.deviceInvalidated ? 'audio-device-invalidated' : 'audio-device-failed', detail };
}

/**
 * What a failure does:
 * - `stopChannel`: the whole path stops;
 * - `holdLater`: later actions are held (rehearsal only, AGENTS §4.8);
 * - `repair`: the wanted state may be sent once more, within the limits of `output-recovery.ts`;
 * - `mark`: red for a failure, nothing for waiting.
 */
export type FailureEffect = { stopChannel: boolean; holdLater: boolean; repair: boolean; mark: 'red' | 'none' };

export function outputFailureEffect(mode: OutputMode, failure: OutputFailure): FailureEffect {
  switch (failure.scope) {
    case 'waiting': return { stopChannel: false, holdLater: false, repair: false, mark: 'none' };
    case 'channel': return { stopChannel: true, holdLater: mode === 'rehearsal', repair: false, mark: 'red' };
    case 'item': return mode === 'rehearsal'
      ? { stopChannel: false, holdLater: true, repair: false, mark: 'red' }
      : { stopChannel: false, holdLater: false, repair: true, mark: 'red' };
  }
}

const itemKey = (channel: OutputChannel, item: string): string => `${channel}\u0000${item}`;

/** The failures of one song, each on its own item; in a rehearsal the first one holds everything after it. */
export class OutputFailureRecord {
  private readonly itemFailures = new Map<string, Extract<OutputFailure, { scope: 'item' }>>();
  private readonly channelFailures = new Map<OutputChannel, Extract<OutputFailure, { scope: 'channel' }>>();
  private first: OutputFailure | null = null;

  constructor(readonly mode: OutputMode) {}

  report(failure: OutputFailure): FailureEffect {
    const effect = outputFailureEffect(this.mode, failure);
    if (failure.scope === 'item') this.itemFailures.set(itemKey(failure.channel, failure.item), failure);
    if (failure.scope === 'channel') this.channelFailures.set(failure.channel, failure);
    if (effect.holdLater && !this.first) this.first = failure;
    return effect;
  }

  /** Rehearsal: the failure that holds every later action, until the song is played again. */
  get holding(): OutputFailure | null { return this.first; }

  /** The item's wanted state moved on (a cut point passed): its old failure no longer applies. */
  clearItem(channel: OutputChannel, item: string): void { this.itemFailures.delete(itemKey(channel, item)); }
  /** The channel works again (reconnected, port back). */
  clearChannel(channel: OutputChannel): void { this.channelFailures.delete(channel); }

  items(): Extract<OutputFailure, { scope: 'item' }>[] { return [...this.itemFailures.values()]; }
  channels(): Extract<OutputFailure, { scope: 'channel' }>[] { return [...this.channelFailures.values()]; }
  stopped(channel: OutputChannel): boolean { return this.channelFailures.has(channel); }
}
