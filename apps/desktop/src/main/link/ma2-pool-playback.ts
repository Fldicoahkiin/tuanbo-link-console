import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ma2PlaybackActionSchema, type Ma2PlaybackAction } from '@tb/schema';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import type { Ma2CommandPriority, Ma2QueueWait } from './ma2-command-queue';
import { runMa2GuardedLua } from './ma2-lua-command';

/** Explicit workbench stop. Read the current Cue from the desk, across all assigned pages and profiles. */
export async function stopMa2ConsoleCues(connection: Pick<Ma2Telnet, 'command'>, current: () => void): Promise<void> {
  const priority: Pick<Ma2Telnet, 'command'> = { command: (line, match, before) =>
    connection.command(line, match, wait => { current(); before?.(wait); }, 'stop') };
  // Release before enumerating the desk. A large Show can take a second to inspect.
  await runMa2GuardedLua(priority, "gma.cmd('Off Timecode Thru');gma.cmd('Off Executor *.* Fade 0');gma.cmd('Off Sequence Thru Fade 0');return 'sent'", current);
  const readRunning = [
    "local o=gma.show.getobj;local pages=assert(o.handle('Page'));local n=0;",
    "for i=0,o.amount(pages)-1 do local p=o.child(pages,i);if p then ",
    "for j=0,o.amount(p)-1 do local e=o.child(p,j);if e and o.class(e)=='CMD_EXEC' then ",
    "local cue=o.handle('Executor '..o.number(p)..'.'..(j+1)..' Cue');",
    "if cue and o.class(cue)=='CMD_CUE' then n=n+1 end end end end end;return n"
  ].join('');
  // The desk may still report the previous Cue for a few render frames after Off Fade 0.
  // Only observe the release. Repeating Off could stop a new audition.
  let running = await runMa2GuardedLua(priority, readRunning, current);
  for (const settleMs of [67, 133, 267]) {
    if (running === '0') return;
    await delay(settleMs);
    current();
    running = await runMa2GuardedLua(priority, readRunning, current);
  }
  if (running !== '0') throw new Error(`控台还有执行器在运行（${running}），请检查控台后再按停止`);
}

export function ma2PlaybackCommand(input: Ma2PlaybackAction): { command: string; object: string } {
  const action = ma2PlaybackActionSchema.parse(input);
  const target = action.target === 'sequence' ? `Sequence ${action.sequence}` : `Executor ${action.executor}`;
  return {
    command: action.action === 'goto' ? `Goto Cue ${action.cue} ${target}` : `${action.action === 'go' ? 'Go' : 'Off'} ${target}`,
    object: action.target === 'sequence' && action.action === 'goto' ? `${target} Cue ${action.cue}` : target
  };
}

/** Numeric DTOs only. The receipt confirms command dispatch, not physical fixture output. Resolves with how long
 * the command waited for the console line. */
export async function playMa2Cue(connection: Pick<Ma2Telnet, 'command'>, action: Ma2PlaybackAction, beforeSend: () => void, priority: Ma2CommandPriority = 'playback', options?: { immediateOff?: boolean }): Promise<Ma2QueueWait> {
  const { command: nativeCommand, object } = ma2PlaybackCommand(action);
  // Audition handoff releases immediately; native song stops retain their timing.
  const command = `${nativeCommand}${action.action === 'off' && options?.immediateOff ? ' Fade 0' : ''}`;
  const marker = `TBLINK_PLAY_${randomBytes(16).toString('hex')}`;
  // Off is idempotent: a deleted/missing target must not trap audition cleanup.
  // Still dispatch the exact Off command and require its receipt; disconnects
  // and unknown outcomes remain failures instead of silently clearing ownership.
  const dispatch = `gma.cmd('${command}');gma.echo('${marker}:SENT')`;
  const script = action.action === 'off' ? dispatch : `if gma.show.getobj.handle('${object}') then ${dispatch} else gma.echo('${marker}:MISSING') end`;
  const sent: { wait?: Ma2QueueWait } = {};
  const result = await connection.command(`Lua "${script}"`, text => ma2ResponseLine(text, `${marker}:`), wait => { sent.wait = wait; beforeSend(); }, priority);
  if (result === 'MISSING') throw new Error(`控台上已经没有 ${object} 了，可能在控台上删掉了。点“刷新素材目录”重新读取，它就不会再显示`);
  if (result !== 'SENT') throw new Error(`控台没有确认 ${command} 是否执行，请检查连接`);
  // The line only goes out after beforeSend: a receipt without a recorded wait is a broken connection contract.
  if (!sent.wait) throw new Error(`控台确认了 ${command}，但联动台没有记下它排队的时间，请导出诊断包`);
  return sent.wait;
}
