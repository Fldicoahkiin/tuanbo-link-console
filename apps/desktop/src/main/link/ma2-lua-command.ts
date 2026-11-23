import { randomBytes } from 'node:crypto';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';

export const ma2LuaString = (value: string): string => `unhex('${Buffer.from(value).toString('hex')}')`;
const decode = "local function unhex(h)return (h:gsub('..',function(x)return string.char(tonumber(x,16))end))end;";

type Connection = Pick<Ma2Telnet, 'command'>;

/**
 * Console commands that ask the show once per step (M3): the first line of a step asks right before it goes out; the
 * lines that finish the step (a long script sent in parts, a file written in parts) go out whatever the show, so a
 * program that starts moving never leaves half a script or half a file on the console. A line sent outside `step` is
 * a step of its own. `gate` throws to stop before a step.
 */
export type Ma2StepConnection = Connection & { step<T>(run: () => Promise<T>): Promise<T> };
export function ma2StepConnection(connection: Connection, gate: () => void): Ma2StepConnection {
  let phase: 'none' | 'starting' | 'running' = 'none';
  return {
    command: (line, match, beforeSend, priority) => connection.command(line, match, wait => {
      if (phase !== 'running') gate();
      if (phase === 'starting') phase = 'running';
      beforeSend?.(wait);
    }, priority),
    async step<T>(run: () => Promise<T>): Promise<T> {
      if (phase !== 'none') return run();
      phase = 'starting';
      try { return await run(); } finally { phase = 'none'; }
    }
  };
}
/** Runs `run` as one step of `connection` when it counts steps, otherwise as it is. */
export function ma2Step<T>(connection: Connection | Ma2StepConnection, run: () => Promise<T>): Promise<T> {
  return 'step' in connection ? connection.step(run) : run();
}

/**
 * Only application-generated scripts, split below the native command-line truncation limit. The script is one step:
 * `beforeSend` asks before its first line only, and the parts after it complete it.
 */
export async function runMa2GuardedLua(connection: Connection | Ma2StepConnection, body: string, beforeSend: () => void): Promise<string> {
  return ma2Step(connection, () => runScript(connection, body, beforeSend));
}
async function runScript(connection: Connection, body: string, beforeSend: () => void): Promise<string> {
  const key = `TBLINK_CUE_${randomBytes(12).toString('hex')}`;
  const prefix = `${key}:`;
  let first = true;
  const call = async (code: string): Promise<string> => connection.command(`Lua "${code}"`, text => ma2ResponseLine(text, prefix), () => { if (first) beforeSend(); first = false; });
  const script = `${decode}local ok,r=pcall(function() ${body} end);gma.echo('${prefix}'..(ok and 'OK:' or 'ERR:')..tostring(r))`;
  let command = script;
  // The native command interpreter consumes $, |, ^ and quotes before Lua
  // sees them. Transport those scripts as hex, even when they are short.
  if (Buffer.byteLength(script) > 900 || /["$|^\\\r\n]/.test(script)) {
    const bytes = Buffer.from(script);
    // Large selector scripts already contain hex-encoded XML. Carry letters and digits
    // directly and escape every other byte, including the escape marker itself.
    const escaped = bytes.length >= 4096 ? bytes.toString('latin1').replace(/[^a-zA-Z0-9]/g, ch => '_' + ch.charCodeAt(0).toString(16).padStart(2, '0')) : null;
    const compact = escaped !== null && escaped.length + 700 < bytes.length * 2;
    const data = compact ? escaped : bytes.toString('hex');
    // Keep encoded transport lines below 700 bytes, including the native Lua wrapper.
    const runHex = (expression: string) => `${decode}assert(load(unhex(${expression}),'tblink_cue','t'))()`;
    const single = data.length < 700 ? runHex(`'${data}'`) : null;
    if (single && Buffer.byteLength(`Lua "${single}"`) < 700) command = single;
    else {
      const receipt = `;gma.echo('${prefix}READY')`;
      const chunkLength = 698 - Buffer.byteLength(`Lua "table.insert(${key},'')${receipt}"`);
      for (let offset = 0; offset < data.length; offset += chunkLength) {
        const part = data.slice(offset, offset + chunkLength);
        const store = offset === 0 ? `${key}={'${part}'}` : `table.insert(${key},'${part}')`;
        if (await call(store + receipt) !== 'READY') throw new Error('控台没有确认收到操作');
      }
      const execute = compact ? `local d={};for i=0,255 do d[string.format('%02x',i)]=string.char(i) end;local b=s:gsub('_(%x%x)',d);assert(#b==${bytes.length});assert(load(b,'tblink_cue','t'))()` : runHex('s');
      command = `local s=table.concat(${key});${key}=nil;${execute}`;
    }
  }
  const result = await call(command);
  if (!result.startsWith('OK:')) throw new Error(`控台操作未完成：${result.slice(4)}`);
  return result.slice(3);
}
