import type { ElectronApplication } from '@playwright/test';

type Ports = { inputs?: readonly string[]; outputs?: readonly string[] };
type Sent = { port: string; bytes: number[] };
type Stub = { sent: Sent[]; setPorts(ports: { inputs: string[]; outputs: string[] }): void; deliver(port: string, bytes: number[]): void };

export type MidiPortsStub = {
  /** Every message the window sent, oldest first; with `port`, only those sent to that output. */
  sent(port?: string): Promise<number[][]>;
  clear(): Promise<void>;
  /** Plugs or unplugs ports: the window gets the new list at once, and what it had open on a missing port closes. */
  setPorts(ports: Ports): Promise<void>;
  /** A message arriving at every open input of this name. */
  deliver(port: string, bytes: readonly number[]): Promise<void>;
  /** Gives the window the computer's MIDI again. */
  restore(): Promise<void>;
};

const channels = ['link:midi-ports', 'link:midi-open', 'link:midi-send', 'link:midi-close'];

/** Stand-in MIDI ports for the window. The window's MIDI goes through main, so the stand-in replaces main's
 * MIDI channels: the window lists, opens and sends as usual, and the test sees what was sent and delivers
 * messages. Formal playback lists its devices separately (`link:native-player-devices`). */
export async function stubMidiPorts(app: ElectronApplication, ports: Ports = {}): Promise<MidiPortsStub> {
  await app.evaluate(({ ipcMain, BrowserWindow }, { initial, names }) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, unknown>;
    if (!Reflect.has(globalThis, '__midiPortsReal')) Reflect.set(globalThis, '__midiPortsReal', new Map(names.map(name => [name, handlers.get(name)])));
    const state = { inputs: initial.inputs, outputs: initial.outputs, next: 0, handles: new Map<number, { direction: 'input' | 'output'; name: string }>() };
    const sent: { port: string; bytes: number[] }[] = [];
    const list = () => ({ version: 1, inputs: state.inputs.map((name, id) => ({ id, name })), outputs: state.outputs.map((name, id) => ({ id, name })) });
    const emit = (event: unknown): void => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('link:midi-event', event); };
    Reflect.set(globalThis, '__midiPortsStub', {
      sent,
      setPorts(next: { inputs: string[]; outputs: string[] }) {
        state.inputs = next.inputs; state.outputs = next.outputs;
        for (const [handle, port] of state.handles) {
          if ((port.direction === 'input' ? state.inputs : state.outputs).includes(port.name)) continue;
          state.handles.delete(handle);
          emit({ version: 1, kind: 'closed', handle, reason: `MIDI 接口「${port.name}」已断开。重新插好后再打开。` });
        }
        emit({ version: 1, kind: 'ports', ports: list() });
      },
      deliver(name: string, bytes: number[]) {
        for (const [handle, port] of state.handles) if (port.direction === 'input' && port.name === name) emit({ version: 1, kind: 'message', handle, bytes, ageMs: 0 });
      }
    });
    for (const name of names) ipcMain.removeHandler(name);
    ipcMain.handle('link:midi-ports', () => list());
    ipcMain.handle('link:midi-open', (_event, request: { direction: 'input' | 'output'; portName: string }) => {
      if (!(request.direction === 'input' ? state.inputs : state.outputs).includes(request.portName)) throw new Error(`MIDI 接口「${request.portName}」没有连接。请检查 USB 线和驱动。`);
      const handle = ++state.next;
      state.handles.set(handle, { direction: request.direction, name: request.portName });
      return { version: 1, handle };
    });
    ipcMain.handle('link:midi-send', (_event, request: { handle: number; bytes: number[] }) => {
      const port = state.handles.get(request.handle);
      if (!port) throw new Error('MIDI 接口已关闭，消息没有发出');
      sent.push({ port: port.name, bytes: request.bytes });
    });
    ipcMain.handle('link:midi-close', (_event, request: { handle: number }) => { state.handles.delete(request.handle); });
    // The window may have read the computer's ports already.
    emit({ version: 1, kind: 'ports', ports: list() });
  }, { initial: { inputs: [...ports.inputs ?? []], outputs: [...ports.outputs ?? []] }, names: channels });
  return {
    sent: port => app.evaluate((_electron, name) => (Reflect.get(globalThis, '__midiPortsStub') as Stub).sent
      .filter(entry => name === null || entry.port === name).map(entry => entry.bytes), port ?? null),
    clear: () => app.evaluate(() => { (Reflect.get(globalThis, '__midiPortsStub') as Stub).sent.length = 0; }),
    setPorts: next => app.evaluate((_electron, value) => { (Reflect.get(globalThis, '__midiPortsStub') as Stub).setPorts(value); },
      { inputs: [...next.inputs ?? []], outputs: [...next.outputs ?? []] }),
    deliver: (port, bytes) => app.evaluate((_electron, value) => { (Reflect.get(globalThis, '__midiPortsStub') as Stub).deliver(value.port, value.bytes); },
      { port, bytes: [...bytes] }),
    restore: () => app.evaluate(({ ipcMain }, names) => {
      const real = Reflect.get(globalThis, '__midiPortsReal') as Map<string, Parameters<typeof ipcMain.handle>[1]> | undefined;
      if (!real) return;
      for (const name of names) { ipcMain.removeHandler(name); const handler = real.get(name); if (handler) ipcMain.handle(name, handler); }
      Reflect.deleteProperty(globalThis, '__midiPortsStub');
    }, channels)
  };
}
