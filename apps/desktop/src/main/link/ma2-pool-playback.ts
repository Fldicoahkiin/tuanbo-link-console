import { randomBytes } from 'node:crypto';
import { ma2PlaybackActionSchema, type Ma2PlaybackAction } from '@tb/schema';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';

export function ma2PlaybackCommand(input: Ma2PlaybackAction): { command: string; object: string } {
  const action = ma2PlaybackActionSchema.parse(input);
  const target = action.target === 'sequence' ? `Sequence ${action.sequence}` : `Executor ${action.executor}`;
  return {
    command: action.action === 'goto' ? `Goto Cue ${action.cue} ${target}` : `${action.action === 'go' ? 'Go' : 'Off'} ${target}`,
    object: action.target === 'sequence' && action.action === 'goto' ? `${target} Cue ${action.cue}` : target
  };
}

/** Numeric DTOs only. The receipt confirms command dispatch, not physical fixture output. */
export async function playMa2Cue(connection: Pick<Ma2Telnet, 'command'>, action: Ma2PlaybackAction, beforeSend: () => void, priority:'normal'|'playback'|'stop'='playback'): Promise<void> {
  const { command, object } = ma2PlaybackCommand(action);
  const marker = `TBLINK_PLAY_${randomBytes(16).toString('hex')}`;
  // Off is idempotent: a deleted/missing target must not trap audition cleanup.
  // Still dispatch the exact Off command and require its receipt; disconnects
  // and unknown outcomes remain failures instead of silently clearing ownership.
  const dispatch = `gma.cmd('${command}');gma.echo('${marker}:SENT')`;
  const script = action.action === 'off' ? dispatch : `if gma.show.getobj.handle('${object}') then ${dispatch} else gma.echo('${marker}:MISSING') end`;
  const result = await connection.command(`Lua "${script}"`, text => ma2ResponseLine(text, `${marker}:`), beforeSend, priority);
  if (result === 'MISSING') throw new Error(`控台上已经没有 ${object} 了，可能在控台上删掉了。点“刷新素材目录”重新读取，它就不会再显示`);
  if (result !== 'SENT') throw new Error(`控台没有确认 ${command} 是否执行，请检查连接`);
}
