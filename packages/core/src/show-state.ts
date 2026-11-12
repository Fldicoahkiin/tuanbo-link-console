import type { ProgramPlayerState } from '@tb/schema';
import type { LinkRuntimeState } from './cue-runtime';

/**
 * Whether the show is on, and what each operation may do meanwhile: the one place that answers it (00-order §2.4).
 * 2026-11-10 (第 3 题) and 2026-11-11 (第 7 题): only a program whose music moves is running — the internal player
 * playing, whether MTC output is on or off, P1 sending moving time code, or a local preview playing. Paused, paused at
 * the end and P1 waiting for the next song are held: the console is synced, its pages refreshed, its executors changed and
 * the connections checked as when stopped. A wait is not a failure (AGENTS §4) and continuing after it is not a retry.
 */

export type ShowClockSource = 'internal' | 'p1' | 'preview';
export type ShowHeldReason = 'paused' | 'ended' | 'p1-waiting' | 'timecode-lost' | 'error';
/** A program that plays on in the background: after a reload that did not reopen its project, the window says so. */
export type ShowProgram = { projectPath: string; projectId: string; watched: boolean };
export type ShowState =
  | { phase: 'idle'; program: ShowProgram | null }
  | { phase: 'preparing'; source: ShowClockSource; itemId: string | null; program: ShowProgram | null }
  | { phase: 'running'; source: ShowClockSource; itemId: string | null; program: ShowProgram | null }
  | { phase: 'stopping'; source: ShowClockSource; itemId: string | null; program: ShowProgram | null }
  | { phase: 'held'; source: ShowClockSource; itemId: string | null; reason: ShowHeldReason; program: ShowProgram | null };
export type ShowPhase = ShowState['phase'];

export type ShowInputs = {
  /** The internal player as the background program reports it; `lightingOffOwed`: the Off a stop owes is still being sent. */
  internal: (Pick<ProgramPlayerState, 'status' | 'itemId' | 'positionMs' | 'durationMs'> & { lightingOffOwed: boolean }) | null;
  /** P1 following, as the window reports it. */
  p1: { state: LinkRuntimeState; itemId: string | null } | null;
  /** The editor's or the lighting workbench's own preview is playing. */
  preview: boolean;
  program: ShowProgram | null;
};

type Busy = Exclude<ShowState, { phase: 'idle' }>;

export function deriveShowState(input: ShowInputs): ShowState {
  const program = input.program;
  const candidates = [internalShow(input.internal, program), p1Show(input.p1, program),
    input.preview ? { phase: 'running', source: 'preview', itemId: null, program } satisfies Busy : null]
    .filter((show): show is Busy => show !== null);
  // The busiest source decides; on a tie the earlier one (internal, then P1, then preview).
  return candidates.reduce<ShowState>((busiest, show) => busyness(show.phase) > busyness(busiest.phase) ? show : busiest, { phase: 'idle', program });
}

function busyness(phase: ShowPhase): number {
  switch (phase) {
    case 'running': return 3;
    case 'preparing': case 'stopping': return 2;
    case 'held': return 1;
    case 'idle': return 0;
  }
}

function internalShow(internal: ShowInputs['internal'], program: ShowProgram | null): Busy | null {
  if (!internal) return null;
  const { itemId } = internal;
  switch (internal.status) {
    // 第 7 题: the music moving is what counts, not whether MTC output is on.
    case 'playing': return { phase: 'running', source: 'internal', itemId, program };
    case 'preparing': return { phase: 'preparing', source: 'internal', itemId, program };
    case 'paused': {
      const ended = internal.durationMs > 0 && internal.positionMs >= internal.durationMs;
      return { phase: 'held', source: 'internal', itemId, reason: ended ? 'ended' : 'paused', program };
    }
    case 'error':
      if (itemId) return { phase: 'held', source: 'internal', itemId, reason: 'error', program };
      return internal.lightingOffOwed ? { phase: 'stopping', source: 'internal', itemId, program } : null;
    case 'stopped': return internal.lightingOffOwed ? { phase: 'stopping', source: 'internal', itemId, program } : null;
  }
}

function p1Show(p1: ShowInputs['p1'], program: ShowProgram | null): Busy | null {
  if (!p1) return null;
  const { itemId } = p1;
  switch (p1.state) {
    case 'idle': return null;
    case 'preflight': return { phase: 'preparing', source: 'p1', itemId, program };
    case 'running': return { phase: 'running', source: 'p1', itemId, program };
    case 'stopping': return { phase: 'stopping', source: 'p1', itemId, program };
    case 'armed': case 'paused': return { phase: 'held', source: 'p1', itemId, reason: 'p1-waiting', program };
    case 'timecodeLost': return { phase: 'held', source: 'p1', itemId, reason: 'timecode-lost', program };
    case 'error': return { phase: 'held', source: 'p1', itemId, reason: 'error', program };
  }
}

/**
 * How each operation meets the show:
 * - `always`: at any time.
 * - `clock`: waits while the program moves, prepares or stops; allowed when stopped and when held (第 3 题).
 * - `stopped`: only when stopped. Everything 第 3 题 and 第 1 题 did not open keeps today's rule, which counts a pause in.
 * - `song`: only while the song it touches is not on stage (preparing, playing, paused, stopping); 第 5 题 (2026-11-11).
 */
type ShowRule =
  | { kind: 'always' }
  | { kind: 'clock'; action: string }
  | { kind: 'stopped'; action: string }
  | { kind: 'song'; action: string };

const always = { kind: 'always' } as const;
const clock = (action: string) => ({ kind: 'clock', action }) as const;
const stopped = (action: string) => ({ kind: 'stopped', action }) as const;
const song = (action: string) => ({ kind: 'song', action }) as const;

/** The waits' fixed openings: a text that starts with one of them is a wait, across IPC too (`isShowWait`). A wait for
 * the clock says the phase the program is in (00-order §9): moving, preparing or stopping. */
export const SHOW_WAIT_CLOCK_MOVING = '节目在走，';
export const SHOW_WAIT_PREPARING = '节目在准备，';
export const SHOW_WAIT_STOPPING = '节目在停止，';
export const SHOW_WAIT_SHOW_ON = '演出还没停止，';
const SHOW_WAIT_OPENINGS = [SHOW_WAIT_CLOCK_MOVING, SHOW_WAIT_PREPARING, SHOW_WAIT_STOPPING, SHOW_WAIT_SHOW_ON] as const;

export const showOperationRules = {
  'ma2.sync.write': clock('同步控台'),
  'ma2.sync.read': clock('读取控台'),
  'ma2.executorPage.refresh': clock('刷新控台页'),
  'ma2.executorPage.press': always,
  'ma2.executor.mutate': clock('修改执行器'),
  'ma2.check': clock('检查控台连接'),
  'ma2.discover': clock('搜索控台'),
  'ma2.connect': stopped('换控台或改连接设置'),
  'ma2.reconnect': always,
  // 2026-11-01 用户定“单击 Cue 试听仍直接发这一个 Cue”: at any time, the program moving too (00-order §12: the gate
  // 02 S3b put on it was never chosen, and would change how the room works). Add one only when the operator asks.
  'ma2.audition': always,
  'ma2.networkSetup': stopped('设置网卡'),
  'connections.check': clock('检查连接'),
  'obs.connect': stopped('连接或更换 OBS'),
  'obs.reconnect': always,
  'obs.repair': stopped('修复 OBS 组件'),
  'obs.standalonePrepare': stopped('单独准备画面'),
  'midi.check': clock('检测 MIDI 设备'),
  'midi.virtualPorts': stopped('设置虚拟 MIDI 端口'),
  'edit.document': always,
  'rundown.reorder': stopped('调整节目顺序'),
  'song.audio.edit': song('换音频、修剪音频、加空白或改 MTC 起始码'),
  'song.remove': song('删除或停用这首歌'),
  'document.replace': stopped('新建、打开或还原工程'),
  'document.saveAs': stopped('另存工程'),
  'document.save': always,
  'media.analyze': stopped('分析音乐'),
  // Rendering a song's audio (blank time added, 0.5.9 E15) mixes in the main process, which also sends the show's
  // pictures: it refuses while the show is on (`link:render-audio-segments`), for every song, so the editor says so first.
  'audio.render': stopped('生成音频'),
  'media.editAudio': stopped('编辑音频'),
  'media.import': stopped('导入素材'),
  'media.relink': stopped('找回素材'),
  'media.prepareAudio': stopped('准备素材音频'),
  'editor.preview': stopped('在编辑器里预览'),
  'p1.import': stopped('从 P1 导入'),
  'settings.devices': stopped('改设备设置'),
  'license.change': stopped('更改授权'),
  'purchase': stopped('购买'),
  'update.download': stopped('下载更新'),
  'update.install': stopped('安装更新'),
  'program.recover': stopped('恢复节目音频'),
  'program.maintenance': stopped('维护节目组件'),
  'app.devReload': stopped('重新加载页面'),
  // The main process keeps the app open while the show is on and says why (showRuntimeActiveExitWarning); the quit
  // flow's own questions (unsaved work, lights left on) come after it. Aligned in S2: a wait, not a question.
  'app.quit': stopped('退出')
} as const satisfies Record<string, ShowRule>;

export type ShowOperation = keyof typeof showOperationRules;
/** The operations that touch one song: `showGate` takes that song's id. */
export type ShowSongOperation = { [Op in ShowOperation]: (typeof showOperationRules)[Op] extends { kind: 'song' } ? Op : never }[ShowOperation];

export type ShowGate =
  | { kind: 'allow' }
  | { kind: 'wait'; until: 'clock-stopped' | 'idle'; message: string };

const allow: ShowGate = { kind: 'allow' };

/**
 * Whether `op` may run now. `itemId`: the song a song operation touches; without it any song on stage holds it. The window
 * asks first to disable its buttons, the main process asks again and has the last word.
 */
export function showGate(op: ShowOperation, show: ShowState, itemId?: string): ShowGate {
  const rule: ShowRule = showOperationRules[op];
  switch (rule.kind) {
    case 'always': return allow;
    case 'clock':
      switch (show.phase) {
        case 'idle': case 'held': return allow;
        case 'running': return { kind: 'wait', until: 'clock-stopped', message: `${SHOW_WAIT_CLOCK_MOVING}暂停或停止后再${rule.action}。` };
        case 'preparing': return { kind: 'wait', until: 'clock-stopped', message: `${SHOW_WAIT_PREPARING}暂停或停止后再${rule.action}。` };
        case 'stopping': return { kind: 'wait', until: 'clock-stopped', message: `${SHOW_WAIT_STOPPING}停下以后再${rule.action}。` };
      }
    case 'stopped':
      return show.phase === 'idle' ? allow : { kind: 'wait', until: 'idle', message: `${SHOW_WAIT_SHOW_ON}停止后再${rule.action}。` };
    case 'song':
      // P1 may not say which song it plays: then every song counts as on stage.
      return show.phase === 'idle' || (itemId !== undefined && show.itemId !== null && show.itemId !== itemId) ? allow
        : { kind: 'wait', until: 'idle', message: `${SHOW_WAIT_SHOW_ON}这首歌还在台上，停下它以后再${rule.action}。` };
  }
}

/** How a main-process service reads the show for one operation: `ShowStateService.gate`. */
export type ShowGateReader = (op: ShowOperation) => ShowGate;

/**
 * Throws the wait when `op` has to wait now, in `showGate`'s own words so the window knows it for a wait (`isShowWait`).
 * A long operation asks before each step, so the step on the wire finishes and the next one is not sent (02 §4.4);
 * `reached` says where it stopped, after the wait.
 */
export function holdForShow(read: ShowGateReader, op: ShowOperation, reached = ''): void {
  const gate = read(op);
  if (gate.kind === 'wait') throw new Error(`${gate.message}${reached}`);
}

/** A wait that came back as an error, across IPC too: Electron passes only the message, wrapped. */
export function isShowWait(error: unknown): boolean {
  const raw = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : String(error);
  const text = raw.replace(/Error invoking remote method '[^']+':\s*/g, '').replace(/\bError:\s*/g, '').trim();
  return SHOW_WAIT_OPENINGS.some(opening => text.startsWith(opening));
}
