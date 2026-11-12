import { afterEach, expect, it, vi } from 'vitest';
import { frameNumberToTimecode, P1FollowSession } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkAction, type LinkProject } from '@tb/schema';
import { MidiPortBroker } from './midi-port-broker';
import { NativeMidiHost, type NativeMidiChannelState } from './native-midi-host';
import type { NativeMidiMessage } from './native-midi-input';
import { P1MidiOutput } from './p1-midi-output';

/*
 * P1's quarter frames carry the MIDI interface's timestamp (tools/playback-engine/midi-input.c), which can run a fraction
 * of a ms ahead of the main process's clock. From the claimed input through the follow to the song's action MIDI: such a
 * timestamp is delivered as now (midi-port-broker.ts `deliver`), and the song's actions go out.
 */

const FRAME_MS = 1000 / 30;

function project(): LinkProject {
  const cues: { frame: number; action: LinkAction }[] = [
    { frame: 0, action: { id: 'note', label: '开场', kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 100 } },
    { frame: 60, action: { id: 'pc2', label: 'PC 2', kind: 'midi.programChange', portProfileId: 'out', channel: 1, program: 2 } }
  ];
  return parseLinkProject({ ...createEmptyLinkProject('演出'), playbackSource: 'p1', rundown: [{ id: 'song', title: '歌曲',
    cues: cues.map((cue, index) => ({ id: `cue-${index}`, name: cue.action.label, timecode: frameNumberToTimecode(cue.frame, '30'), actions: [cue.action] })),
    referenceAudio: { assetId: 'audio', relativePath: 'assets/song.wav', sha256: 'a'.repeat(64), durationMs: 60_000 } }] });
}

let broker: MidiPortBroker | null = null;
afterEach(async () => { await broker?.dispose(); broker = null; });

it('P1 的时间码比主进程的时钟早 0.3 ms 到：按收到的那一刻算，这首歌的动作照常发出，什么都不标红', async () => {
  const p = project();
  // The one clock of the main process (process.hrtime): the broker reads it in 100 ns, the action MIDI host in ms.
  let now100ns = 0n;
  let receive: (message: NativeMidiMessage) => void = () => undefined;
  broker = new MidiPortBroker({
    authorize: () => Promise.resolve(),
    list: () => Promise.resolve({ midiInputs: [{ id: 0, name: 'P1 MTC' }], midiOutputs: [] }),
    createOutput: () => { throw new Error('这里不开输出'); },
    createInput: delivered => { receive = delivered; return { open: () => Promise.resolve(), close: () => Promise.resolve() }; },
    emit: () => undefined, log: () => undefined, pollMs: 3000,
    now100ns: () => now100ns
  });
  const ports = { prepare: vi.fn(() => Promise.resolve()), send: vi.fn<(profileId: string, bytes: readonly number[]) => Promise<void>>(() => Promise.resolve()), close: vi.fn(() => Promise.resolve()) };
  const errors: string[] = [], faults: string[] = [], states: NativeMidiChannelState[] = [];
  const host = new NativeMidiHost({ audio: () => null, profile: () => null, executable: 'unused', now: () => Number(now100ns) / 10_000, authorize: () => Promise.resolve(),
    ports: () => ports, changed: state => { states.push(state); }, error: message => { errors.push(message); }, fault: message => { faults.push(message); },
    outputs: () => Promise.resolve([{ id: 3, name: 'X' }]), recovered: () => undefined });
  const follow = new P1FollowSession(p, 'manual', { outputs: new P1MidiOutput(p, host, () => undefined), prepare: () => undefined, lights: { change: () => undefined, stop: () => undefined } });
  const claim = await broker.claimInput('P1 MTC', 'P1 时间码', { message: message => { follow.message(message.bytes, message.at100ns); }, idle: () => undefined, closed: () => undefined });
  follow.arm('song');
  for (let frame = 0; frame < 90; frame += 2) {
    const tc = frameNumberToTimecode(frame, '30');
    const pieces = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
    for (const [type, value] of pieces.entries()) {
      const stamped100ns = BigInt(Math.round((1_000 + (frame + type / 4) * FRAME_MS) * 10_000));
      now100ns = stamped100ns - 3_000n;
      receive({ bytes: [0xf1, (type << 4) | value], at100ns: stamped100ns });
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  await vi.waitFor(() => expect(ports.send.mock.calls.map(call => call[1])).toEqual([[0x90, 60, 100], [0xc0, 2]]));
  expect(follow.view.phase).toBe('running');
  expect({ errors, faults, failed: states.filter(state => state.state === 'failed') }).toEqual({ errors: [], faults: [], failed: [] });
  await host.stop();
  await claim.release();
});
