import { describe, expect, it, vi } from 'vitest';
vi.mock('./license-output', () => ({ requireOutputLicense: vi.fn() }));
vi.mock('./midi-access', () => ({ requestMidiAccess: vi.fn(), refreshMidiAccess: vi.fn() }));
import { encodeMidiAction, midiMessageNeedsLicense, type MidiAction } from '@tb/core/link';
import { LinkMidiAdapter } from './link-midi-adapter';
import { requireOutputLicense } from './license-output';
import { requestMidiAccess, type MidiAccess, type MidiOutput } from './midi-access';
import { NativeMidiPorts } from '../../../main/link/native-midi-ports';

/**
 * 授权失效时哪些 MIDI 照发（2026-11-09 定，docs/LICENSE_IMPLEMENTATION.md，规则测试 license-rules.test.ts）：只有 Note Off
 * 和 MSC Stop。界面的 MIDI 适配器和后台节目只按 core 里的一条规则（midiMessageNeedsLicense）判断，这里守着两边一致。
 * 界面的适配器要 DOM 类型，所以这条放在界面的测试里。
 */

/** The editor's MIDI output in the window, with one port. */
function windowMidi(sent: number[][]): MidiAccess {
  const output: MidiOutput = { id: 'out', name: '控台', manufacturer: 'test', type: 'output', state: 'connected', connection: 'open', closedReason: null,
    open: () => Promise.resolve(), close: () => Promise.resolve(), onStateChange: () => () => undefined, send: data => { sent.push([...data]); } };
  return { inputs: new Map(), outputs: new Map([['out', output]]), failure: null, onStateChange: () => () => undefined };
}

describe('哪些 MIDI 不用授权：界面和后台节目只有一条规则（midiMessageNeedsLicense）', () => {
  it('授权到期时，界面和后台节目对每种 MIDI 动作的判断一样：只有 Note Off 和 MSC Stop 照发', async () => {
    const port = { portProfileId: 'out', channel: 1 } as const;
    const actions: MidiAction[] = [
      { id: 'on', label: 'Note On', kind: 'midi.noteOn', ...port, note: 60, velocity: 100 },
      { id: 'silent', label: '力度 0 的 Note On', kind: 'midi.noteOn', ...port, note: 60, velocity: 0 },
      { id: 'off', label: 'Note Off', kind: 'midi.noteOff', ...port, note: 60, velocity: 0 },
      { id: 'cc', label: 'CC', kind: 'midi.controlChange', ...port, controller: 7, value: 100 },
      { id: 'pc', label: 'Program Change', kind: 'midi.programChange', ...port, program: 3 },
      ...(['go', 'stop', 'resume', 'load'] as const).map((command): MidiAction => ({ id: command, label: `MSC ${command}`, kind: 'midi.showControl',
        portProfileId: 'out', deviceId: 127, commandFormat: 1, command, cueNumber: '1' }))
    ];
    const refused = new Error('使用团播联动台需要有效授权：授权已到期');
    // The window: the editor's MIDI adapter (link-midi-adapter) with the license refused.
    const fromWindow: number[][] = [];
    vi.mocked(requireOutputLicense).mockRejectedValue(refused); vi.mocked(requestMidiAccess).mockResolvedValue(windowMidi(fromWindow));
    const adapter = new LinkMidiAdapter(id => id === 'out' ? { id, direction: 'output', portName: '控台' } : null, vi.fn());
    await adapter.initialize();
    const byWindow: string[] = [];
    for (const action of actions) byWindow.push((await Promise.allSettled([adapter.execute(action)]))[0].status);
    adapter.dispose();
    // The playback program: its ports opened while the show was licensed, then the license lapsed (native-midi-ports).
    const fromProgram: number[][] = [], authorize = vi.fn(() => Promise.resolve());
    const ports = new NativeMidiPorts({ midiPortProfiles: [{ id: 'out', direction: 'output', portName: '控台' }] }, { executable: 'tblink-midi.exe', authorize, failed: vi.fn(),
      create: () => ({ open: () => Promise.resolve(), close: () => Promise.resolve(),
        send: bytes => { fromProgram.push([...bytes]); return Promise.resolve({ acceptedAt100ns: 1n }); } }) });
    await ports.prepare(['out'], new AbortController().signal);
    authorize.mockRejectedValue(refused);
    const byProgram: string[] = [];
    for (const action of actions) byProgram.push((await Promise.allSettled([ports.send('out', encodeMidiAction(action), 1000)]))[0].status);
    await ports.close();
    expect(byProgram).toEqual(byWindow);
    expect(fromProgram).toEqual(fromWindow);
    expect(fromWindow).toEqual([[0x80, 60, 0], [0xf0, 0x7f, 127, 0x02, 1, 0x02, 0x31, 0xf7]]);
    expect(byWindow).toEqual(actions.map(action => midiMessageNeedsLicense(encodeMidiAction(action)) ? 'rejected' : 'fulfilled'));
  });
});
