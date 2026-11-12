import { z } from 'zod';
import { integrationProfileSchema } from './integration-profile';
import { mtcFrameRateSchema, smpteTimecodeSchema } from './link-project';

/*
 * P1 follow in the main process (0.5.9 P3, design 03 §4.1.4 and §4.1.7): what the window asks of it
 * (link:p1-follow) and what it shows the window back (link:p1-follow-state). The main process follows P1's MTC
 * (p1-follow-host.ts); the window only sends the operator's commands and shows this state.
 */

/** How the follow was started, and the run mode its outputs take (AGENTS §4.8). */
export const p1FollowModeSchema = z.enum(['manual', 'auto']);
export type P1FollowMode = z.infer<typeof p1FollowModeSchema>;

const itemIdSchema = z.string().min(1).max(200);

/**
 * - `start`: follow this project (as saved: P1 follow takes edits after a stop, design 02 §3.5) with the MTC from
 *   the named input. Opens the input; nothing follows until `arm`. Also opens it again after it was unplugged.
 *   `lightingProfile`: this computer's device settings whose MIDI ports the song's actions name, as the native program
 *   takes them (nativeProgramConfigurationSchema); null when there are none.
 * - `arm`: manual, wait for P1 to play this song from its head; auto, `itemId` null: listen for the song P1 plays.
 * - `resync`: manual, after the timecode froze: go on from where P1 is now; what was passed is not sent later.
 * - `rearm`: after the timecode froze: wait for the song's head again (auto: for P1's next song).
 * - `manualTakeover`: after the timecode froze, the operator takes over by hand; the timecode is not followed again.
 * No manual GO or action retry: today's window has no caller for them (0.5.9 P3d); the single action test of the
 * editor is not P1's and stays where it is.
 * - `stop`: stop following; P1 itself is not stopped. The input stays open for the next `arm`.
 * - `close`: stop and let go of the input (the window left this project).
 */
export const p1FollowCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('start'), projectPath: z.string().max(4096), sessionId: z.string().uuid(), revision: z.number().int().nonnegative(),
    // Large documents cross contextBridge as text, as for the native program (native-program.ts).
    document: z.string().min(1).max(128 * 1024 * 1024),
    mode: p1FollowModeSchema, runMode: z.enum(['rehearsal', 'live']), inputPortName: z.string().min(1).max(256),
    lightingProfile: integrationProfileSchema.nullable()
  }).strict(),
  z.object({ kind: z.literal('arm'), itemId: itemIdSchema.nullable() }).strict(),
  z.object({ kind: z.literal('resync') }).strict(),
  z.object({ kind: z.literal('rearm') }).strict(),
  z.object({ kind: z.literal('manualTakeover') }).strict(),
  z.object({ kind: z.literal('stop') }).strict(),
  z.object({ kind: z.literal('close') }).strict()
]);
export type P1FollowCommand = z.infer<typeof p1FollowCommandSchema>;

/** One command from a window's page: `ownerId` is the page's, made once when it loads (as for the native program). */
export const p1FollowRequestSchema = z.object({ version: z.literal(1), ownerId: z.string().uuid(), command: p1FollowCommandSchema }).strict();
export type P1FollowRequest = z.infer<typeof p1FollowRequestSchema>;

/**
 * - `closed`: no project is followed and the input is not held.
 * - `standby`: the input is open, nothing is followed (opened, or stopped).
 * - `waiting`: armed; waiting for P1 to play from the song's head (auto: any song).
 * - `preparing`: auto, P1 started a song; its outputs are getting ready, the timecode is kept meanwhile.
 * - `running`: following; the outputs go with P1's position.
 * - `frozen`: the timecode was lost, jumped or cannot be placed (AGENTS §4.9): automatic Cues stop, nothing between is
 *   guessed or sent later.
 * - `takeover`: after a freeze the operator fires the Cues by hand; the timecode is not followed any more.
 * - `failed`: auto, this song could not start; only P1 playing a song from its head starts again.
 */
export const p1FollowPhaseSchema = z.enum(['closed', 'standby', 'waiting', 'preparing', 'running', 'frozen', 'takeover', 'failed']);
export type P1FollowPhase = z.infer<typeof p1FollowPhaseSchema>;

/** Why the follow froze; the same causes as core `P1FreezeCause` (p1-clock.ts). */
export const p1FollowFreezeCauseSchema = z.enum(['lost', 'jump', 'unknown-range', 'not-from-start', 'frame-rate']);

/** The action MIDI of the song this follow holds, as its host says (native-midi-host.ts NativeMidiChannelState): only
 * what the host reported, never assumed. `reason`: why it failed; `fault`: the last red text of this song (actions late,
 * refused, skipped, or the port gone), cleared when the port came back or another song is prepared. */
export const p1FollowActionMidiSchema = z.object({
  itemId: itemIdSchema, state: z.enum(['preparing', 'ready', 'running', 'stopped', 'failed']),
  reason: z.string().max(8192).nullable(), fault: z.string().max(8192).nullable()
}).strict();
export type P1FollowActionMidi = z.infer<typeof p1FollowActionMidiSchema>;

export const p1FollowStateSchema = z.object({
  version: z.literal(1),
  phase: p1FollowPhaseSchema,
  /** The page that started this follow (its request `ownerId`); only it acts on this state. Null while closed. */
  ownerId: z.string().uuid().nullable(),
  /** Null while closed. */
  projectId: z.string().min(1).nullable(),
  mode: p1FollowModeSchema.nullable(),
  runMode: z.enum(['rehearsal', 'live']).nullable(),
  /** The song followed, prepared or waited for; null when auto waits for any song. */
  itemId: itemIdSchema.nullable(),
  /** One follow of one song and its generation (core ProgramClock); null before the first. */
  sessionId: z.string().min(1).nullable(),
  generation: z.number().int().nonnegative(),
  /** Position inside the song (auto: after its P1 range start); null before the first. */
  positionMs: z.number().finite().nonnegative().nullable(),
  cause: p1FollowFreezeCauseSchema.nullable(),
  /** What the operator reads: why it froze, failed or waits; null when there is nothing to say. */
  reason: z.string().max(8192).nullable(),
  /** The MTC input the main process holds for P1 (midi-port-broker claimInput). Null while closed. */
  input: z.object({
    portName: z.string().min(1).max(256), state: z.enum(['opening', 'open', 'closed']), reason: z.string().max(8192).nullable()
  }).strict().nullable(),
  /** The latest whole timecode from P1 as it came in (not relative to a song), on the interface's clock: `receiving`
   * while one came within 500 ms, `stable` after 500 ms without a gap, jump or frame rate change. */
  mtc: z.object({
    timecode: smpteTimecodeSchema.strict(), frameRate: mtcFrameRateSchema, receiving: z.boolean(), stable: z.boolean()
  }).strict().nullable(),
  /** What each output of the follow is doing, as its own host reports it; null for one that reported nothing yet. The
   * picture joins here with its own field. */
  outputs: z.object({ actionMidi: p1FollowActionMidiSchema.nullable() }).strict()
}).strict().superRefine((state, context) => {
  const closed = state.phase === 'closed';
  if (closed !== (state.projectId === null) || closed !== (state.mode === null) || closed !== (state.runMode === null) || closed !== (state.input === null)
    || closed !== (state.ownerId === null)) {
    context.addIssue({ code: 'custom', message: '只有没跟随时工程、方式和输入口才是空的', path: ['phase'] });
  }
  if ((state.phase === 'frozen') !== (state.cause !== null)) context.addIssue({ code: 'custom', message: '只有冻结时才有冻结原因', path: ['cause'] });
});
export type P1FollowState = z.infer<typeof p1FollowStateSchema>;
