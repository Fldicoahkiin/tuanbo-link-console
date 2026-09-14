import { lightingEventSchema, type LightingEvent } from '@tb/schema';

export type Ma2RecordingBinding = { executor: string; sequence: number };

/** MSC carries executor/page, not sequence identity: conversion requires a known binding. */
function ma2Feedback(bytes: readonly number[], bindings: readonly Ma2RecordingBinding[]): Omit<Extract<LightingEvent, { kind: 'ma2' }>, 'id' | 'at'> | null {
  if (bytes[0] !== 0xf0 || bytes[1] !== 0x7f || bytes[3] !== 2 || ![1, 2, 0x7f].includes(bytes[4] ?? -1) || ![1, 0x0b].includes(bytes[5] ?? -1)) return null;
  const fields = bytes.slice(6, -1).map((byte) => String.fromCharCode(byte)).join('').split('\0');
  const cue = fields[0];
  if (!cue || !/^\d+(?:\.\d{1,3})?$/.test(cue)) return null;
  const address = fields.length === 2 ? fields[1]?.split('.') : fields.length === 3 ? fields.slice(1) : null;
  if (!address || address.length !== 2 || address.some((part) => !/^\d+$/.test(part) || Number(part) < 1)) return null;
  const executor = `${Number(address[1])}.${Number(address[0])}`;
  const candidates = bindings.filter((binding) => binding.executor === executor);
  const sequence = candidates[0]?.sequence;
  if (!sequence || candidates.some((binding) => binding.sequence !== sequence)) return null;
  if (bytes[5] === 0x0b) return { kind: 'ma2', executor, action: 'off', label: `关闭执行器 ${executor}` };
  return { kind: 'ma2', executor, sequence, cue, action: 'goto', label: `Cue ${cue}` };
}

/** Receives complete Web MIDI messages against the actual media clock. Never echoes input. */
export class LightingRecorder {
  private readonly held = new Map<number, Array<{ at: number; velocity: number }>>();
  private previous: number | null = null;
  private events: LightingEvent[] = [];
  constructor(private readonly channel: number, private readonly duration: number, private readonly ma2Bindings: readonly Ma2RecordingBinding[] = []) {
    if (!Number.isInteger(channel) || channel < 1 || channel > 16 || !Number.isFinite(duration) || duration <= 0) throw new Error('录制通道或片段长度无效');
  }
  advance(position: number): void {
    if (!Number.isFinite(position)) throw new Error('录制位置无效');
    // End the previous take on rewind; never create a note across a loop/seek.
    if (this.previous !== null && position < this.previous) this.release(this.previous);
    this.previous = position;
    if (position < 0 || position >= this.duration) this.release(Math.max(0, Math.min(this.duration, position)));
  }
  interrupt(position: number): void {
    if (!Number.isFinite(position)) throw new Error('录制中断位置无效');
    this.release(Math.max(0, Math.min(this.duration, Math.max(position, this.previous ?? position))));
    this.previous = null;
  }
  receive(bytes: readonly number[], position: number): void {
    this.advance(position);
    if (position < 0 || position >= this.duration) return;
    const status = bytes[0]; if (status === undefined) throw new Error('空 MIDI 消息');
    if (status >= 0xf8 || status === 0xf1) return;
    const type = status & 0xf0;
    if (status < 0xf0 && (status & 15) !== this.channel - 1) return;
    const a = bytes[1]; const b = bytes[2];
    const add = (event: LightingEvent): void => { this.events.push(lightingEventSchema.parse(event)); };
    const base = { id: crypto.randomUUID(), at: position };
    if (type === 0x80 || type === 0x90) {
      if (bytes.length !== 3 || a === undefined || b === undefined || a < 0 || a > 127 || b < 0 || b > 127) throw new Error('录制音符消息无效');
      if (type === 0x90 && b > 0) { const pending = this.held.get(a) ?? []; pending.push({ at: position, velocity: b }); this.held.set(a, pending); }
      else { const opened = this.held.get(a)?.shift(); if (opened && position > opened.at) add({ ...base, kind: 'note', note: a, at: opened.at, velocity: opened.velocity, ...(b > 0 ? { releaseVelocity: b } : {}), duration: position - opened.at }); }
    } else if (status === 0xf0) {
      const raw = lightingEventSchema.parse({ ...base, kind: 'raw', bytes: [...bytes], label: 'SysEx / MSC' });
      const decoded = ma2Feedback(bytes, this.ma2Bindings);
      add(decoded ? { ...base, ...decoded } : raw);
    } else if (type === 0xb0 && a !== undefined && b !== undefined && bytes.length === 3) add({ ...base, kind: 'cc', controller: a, value: b });
    else if (type === 0xc0 && a !== undefined && bytes.length === 2) add({ ...base, kind: 'program', program: a });
    else add({ ...base, kind: 'raw', bytes: [...bytes], label: status === 0xf0 ? 'SysEx / MSC' : 'MIDI 控制' });
  }
  finish(position: number): LightingEvent[] {
    if (!Number.isFinite(position)) throw new Error('录制结束位置无效');
    this.interrupt(position);
    const events = this.events.sort((a, b) => a.at - b.at); this.events = []; this.previous = null; return events;
  }
  private release(position: number): void {
    for (const [note, notes] of this.held) for (const opened of notes) {
      if (position > opened.at) this.events.push({ id: crypto.randomUUID(), kind: 'note', note, at: opened.at, duration: position - opened.at, velocity: opened.velocity });
    }
    this.held.clear();
  }
}
