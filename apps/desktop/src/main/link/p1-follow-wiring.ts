import { firstTimeWarning, lightsLeftOnText, toUserErrorReason, type LightingOffOutcome, type LitSong, type P1FollowLights,
  type ShowInputs } from '@tb/core/link';
import { p1FollowRequestSchema, parseLinkProject, type IntegrationProfile, type LinkProject, type P1FollowActionMidi,
  type P1FollowState } from '@tb/schema';
import type { LightingOffService } from './lighting-off-service';
import type { ClosedProgramFaults } from './main-process-errors';
import type { MidiPortBroker } from './midi-port-broker';
import { actionMidiRecoveredEntry, NativeMidiHost } from './native-midi-host';
import { P1FollowHost, type P1FollowOutputSet } from './p1-follow-host';
import { P1FollowOutputList } from './p1-follow-outputs';
import { P1MidiOutput } from './p1-midi-output';
import type { LinkLogInput } from './run-logger';

/*
 * P1 follow in the main process, as link-main wires it (0.5.9 P3f): one P1FollowHost, its IPC
 * (link:p1-follow, link:p1-follow-state-get; its state goes out as link:p1-follow-state), its outputs and lights, the show
 * state's P1 input and the license's running state. link-main only builds this once and calls `pageGone` and
 * `dispose`. Since P4 this is the only P1 follow: the window reaches it only through runtime/p1-follow-client.ts.
 */

export type P1FollowWiringDependencies = {
  /** link-main's `handle`: main window only; the license wrapper checks what needsProductLicense says. */
  handle(channel: string, listener: (event: unknown, value: unknown) => unknown): void;
  /** To the main window (sendToRenderer). */
  send(channel: 'link:p1-follow-state', state: P1FollowState): void;
  broker: Pick<MidiPortBroker, 'claimInput' | 'claimFormal'>;
  /** The playback engine, which runs the MIDI helpers. */
  executable: string;
  /** The license check of every output (link-main's authorizeOutput). */
  authorize(): Promise<void>;
  /** Windows MIDI outputs as listed now, checked again when the last listing failed: waits for a lost action MIDI port. */
  midiOutputs(): Promise<readonly { id: number; name: string }[]>;
  /** The project's own files, as opening the native program checks them (projectAccess.assetFiles). */
  checkFiles(projectPath: string, project: LinkProject): Promise<void>;
  /** The one lights-off ledger. */
  lights: Pick<LightingOffService, 'followChange' | 'followStop'>;
  /** Where failures no follow state shows go: logged as an error, shown once in red, asked about at quit (Offs). */
  faults: Pick<ClosedProgramFaults, 'report' | 'windowOpened'>;
  record(entry: LinkLogInput): Promise<unknown>;
  /** The follow's state changed (ShowStateService.p1Changed). */
  showChanged(): void;
  /** Whether the follow runs the show, for the license (program-license.ts followRunningChanged). */
  running(running: boolean): void;
};

export type P1FollowWiring = {
  readonly host: P1FollowHost;
  /** The show's P1 input while the host has a follow; `undefined` without one (ShowStateService.followP1). */
  showInput(): ShowInputs['p1'] | undefined;
  /** Whether the follow runs the show now (followRuns): the quit and the window's guards wait for it as for a program. */
  running(): boolean;
  /** The main window's page is gone (releaseGonePage): a follow that runs a song goes on without a page until one adopts
   * or stops it; one that follows nothing closes (P1FollowHost.pageGone). */
  pageGone(): Promise<void>;
  /** The app quits: the follow ends, its Offs go out, the input is let go. */
  dispose(): Promise<void>;
};

export function wireP1Follow(dependencies: P1FollowWiringDependencies): P1FollowWiring {
  const log = (entry: LinkLogInput): void => { void dependencies.record(entry).catch((error: unknown) => console.error('P1 跟随日志未能保存', error, entry.message)); };
  let running = false;
  const host: P1FollowHost = new P1FollowHost({
    claimInput: (name, listener) => dependencies.broker.claimInput(name, 'P1 时间码', listener),
    openProject: async (document, projectPath) => {
      const project = parseLinkProject(JSON.parse(document));
      if (project.playbackSource === 'internal') throw new Error('只有“P1 跟随”的工程才能跟随 P1');
      await dependencies.checkFiles(projectPath, project);
      return project;
    },
    outputs: (project, options, changed) => followOutputs(dependencies, project, options.lightingProfile, changed, log),
    prepareSong: (project, itemId) => prepareSong(dependencies, project, itemId),
    changed: state => {
      dependencies.send('link:p1-follow-state', state);
      const now = followRuns(state);
      if (now !== running) { running = now; dependencies.running(now); }
      dependencies.showChanged();
    },
    log: (level, message) => log({ level, category: 'state', device: 'P1 跟随', message, result: level === 'info' ? 'succeeded' : 'failed' })
  });
  dependencies.handle('link:p1-follow', (_event, value) => {
    const request = p1FollowRequestSchema.parse(value);
    // The window subscribed to main-process errors before it starts a follow, as before it opens a program.
    if (request.command.kind === 'start') dependencies.faults.windowOpened();
    return host.command(request);
  });
  dependencies.handle('link:p1-follow-state-get', () => host.state);
  return {
    host,
    showInput: () => p1FollowShowInput(host.state),
    running: () => followRuns(host.state),
    pageGone: () => host.pageGone(null),
    dispose: () => host.dispose()
  };
}

/** The follow holds the show (and the license) from arming until it stops: as the window's run did. Auto-follow still
 * listening for its first song runs nothing yet, as the window's run was idle then. */
export function followRuns(state: P1FollowState): boolean { return p1FollowShowInput(state) != null; }

/** The follow's state as the show reads P1 (packages/core show-state.ts p1Show), as the window's runtime reported it:
 * waiting for the armed song is `armed` (held, like stopped for the console: LIGHTING_WORKFLOW 节目在走时不写控台), preparing is
 * `preflight`, a freeze is `timecodeLost`, a takeover is `paused` (CueRuntime enableManualTakeover), a song that could
 * not start is `error`. `null` while it follows nothing, and while auto-follow listens for its first song (the window's
 * runtime was idle then); `undefined` without a follow. */
export function p1FollowShowInput(state: P1FollowState): ShowInputs['p1'] | undefined {
  const itemId = state.itemId;
  switch (state.phase) {
    case 'closed': return undefined;
    case 'standby': return null;
    case 'waiting': return state.mode === 'auto' && itemId === null ? null : { state: 'armed', itemId };
    case 'preparing': return { state: 'preflight', itemId };
    case 'running': return { state: 'running', itemId };
    case 'frozen': return { state: 'timecodeLost', itemId };
    case 'takeover': return { state: 'paused', itemId };
    case 'failed': return { state: 'error', itemId };
  }
}

/** The license check of the outputs and the song itself: no window preflight (design 03 §4.1.7). The picture's own
 * preparation joins here. */
async function prepareSong(dependencies: Pick<P1FollowWiringDependencies, 'authorize'>, project: LinkProject, itemId: string): Promise<void> {
  await dependencies.authorize();
  const item = project.rundown.find(entry => entry.id === itemId);
  if (!item) throw new Error('P1 放的这首歌不在这个工程里，请在 P1 打开这个工程生成的联动 .hia');
  if (!item.enabled) throw new Error(`「${item.title}」已停用，跟随 P1 时不跟这首歌`);
}

/** One follow's outputs: the action MIDI on its own NativeMidiHost, built as the native program builds its own
 * (native-program-host.ts: the same broker claim, port recovery and run-log lines), and the lights on the one ledger. */
function followOutputs(dependencies: P1FollowWiringDependencies, project: LinkProject, profile: IntegrationProfile | null, changed: () => void,
  log: (entry: LinkLogInput) => void): P1FollowOutputSet {
  const seen = new Set<string>();
  let actionMidi: (P1FollowActionMidi & { sessionId: string }) | null = null;
  const fault = (message: string): void => { if (actionMidi) { actionMidi = { ...actionMidi, fault: message }; changed(); } };
  const midi = new NativeMidiHost({
    // Every song of a follow says where it is through its own source (P1MidiOutput): never the audio player.
    audio: () => null,
    profile: () => profile, executable: dependencies.executable, authorize: () => dependencies.authorize(),
    claim: name => dependencies.broker.claimFormal(name, '动作 MIDI'),
    changed: state => {
      // Another song (or another follow of it) starts without the last one's red text.
      const kept = actionMidi && actionMidi.sessionId === state.sessionId && actionMidi.itemId === state.itemId ? actionMidi.fault : null;
      actionMidi = { sessionId: state.sessionId, itemId: state.itemId, state: state.state, reason: state.reason, fault: kept };
      changed();
    },
    error: message => {
      log({ level: 'error', category: 'device', device: '动作 MIDI', projectId: project.projectId, ...(actionMidi ? { itemId: actionMidi.itemId } : {}), message, result: 'failed' });
      fault(message);
    },
    // A channel that cannot join repeats song after song until fixed: a warning the first time, then info (as the program's notice).
    fault: (message, itemId) => {
      log({ level: firstTimeWarning(seen, message), category: 'state', device: '动作 MIDI', projectId: project.projectId, itemId, message });
      fault(message);
    },
    outputs: () => dependencies.midiOutputs(),
    recovered: (report, itemId) => {
      log(actionMidiRecoveredEntry(report, project.projectId, itemId));
      if (actionMidi?.fault === report.fault) { actionMidi = { ...actionMidi, fault: null }; changed(); }
    }
  });
  const outputs = new P1FollowOutputList([
    { name: '动作 MIDI', output: new P1MidiOutput(project, midi, (level, message) => log({ level, category: 'device', device: '动作 MIDI', projectId: project.projectId, message })) }
    // The picture joins this list as one more entry.
  ], (name, error) => {
    const message = `跟随 P1 时${name}出错：${toUserErrorReason(error)}`;
    log({ level: 'error', category: 'device', device: name, projectId: project.projectId, message, result: 'failed' });
    if (name === '动作 MIDI') fault(message);
  });
  return { outputs, lights: followLights(dependencies, project), state: () => ({ actionMidi: actionMidi ? publicMidi(actionMidi) : null }) };
}

function publicMidi({ itemId, state, reason, fault }: P1FollowActionMidi & { sessionId: string }): P1FollowActionMidi {
  return { itemId, state, reason, fault };
}

/** The follow's lights on the one ledger (LightingOffService followChange, followStop). An Off that did not go out is
 * logged as an error, shown in red once and asked about at quit, under the song it was for; it stays owed there. */
function followLights(dependencies: Pick<P1FollowWiringDependencies, 'lights' | 'faults'>, project: LinkProject): P1FollowLights {
  const lit = (itemId: string | null): LitSong | null => {
    const item = itemId === null ? undefined : project.rundown.find(entry => entry.id === itemId);
    return item?.lighting ? { document: item.lighting, song: { itemId: item.id, title: item.title } } : null;
  };
  const settle = (offs: () => Promise<LightingOffOutcome>, song: LitSong | null): void => {
    let pending: Promise<LightingOffOutcome>;
    try { pending = offs(); } catch (error) { pending = Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    void pending.catch((error: unknown): LightingOffOutcome => ({ failed: [{ song: song?.song ?? null, reason: toUserErrorReason(error) }] })).then(outcome => {
      const shown = new Set<string>();
      for (const { song: owed, reason } of outcome.failed) {
        const message = lightsLeftOnText(owed, reason);
        if (shown.has(message)) continue;
        shown.add(message);
        dependencies.faults.report(message, { projectId: project.projectId, itemId: owed?.itemId ?? null });
      }
    });
  };
  return {
    change: (previous, next) => { const before = lit(previous); settle(() => dependencies.lights.followChange(before, lit(next)), before); },
    stop: (itemId, cause) => { const song = lit(itemId); settle(() => dependencies.lights.followStop(song, cause), song); }
  };
}
