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
export async function playMa2Cue(connection: Pick<Ma2Telnet, 'command'>, action: Ma2PlaybackAction, beforeSend: () => void): Promise<void> {
  const { command, object } = ma2PlaybackCommand(action);
  const marker = `TBLINK_PLAY_${randomBytes(16).toString('hex')}`;
  const script = `if gma.show.getobj.handle('${object}') then gma.cmd('${command}');gma.echo('${marker}:SENT') else gma.echo('${marker}:MISSING') end`;
  const result = await connection.command(`Lua "${script}"`, text => ma2ResponseLine(text, `${marker}:`), beforeSend);
  if (result !== 'SENT') throw new Error(`控台没有找到 ${object}，请重新读取素材并核对编号`);
}
