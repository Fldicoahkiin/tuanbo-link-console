import { randomBytes } from 'node:crypto';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';

export const ma2LuaString = (value: string): string => `unhex('${Buffer.from(value).toString('hex')}')`;
const decode = "local function unhex(h)return (h:gsub('..',function(x)return string.char(tonumber(x,16))end))end;";

/** Only application-generated scripts, split below the native command-line truncation limit. */
export async function runMa2GuardedLua(connection: Pick<Ma2Telnet, 'command'>, body: string, beforeSend: () => void): Promise<string> {
  const key = `TBLINK_CUE_${randomBytes(12).toString('hex')}`;
  const prefix = `${key}:`;
  const call = async (code: string): Promise<string> => connection.command(`Lua "${code}"`, text => ma2ResponseLine(text, prefix), beforeSend);
  const script = `${decode}local ok,r=pcall(function() ${body} end);gma.echo('${prefix}'..(ok and 'OK:' or 'ERR:')..tostring(r))`;
  let command = script;
  // The native command interpreter consumes $, |, ^ and quotes before Lua
  // sees them. Transport those scripts as hex, even when they are short.
  if (Buffer.byteLength(script) > 900 || /["$|^\\\r\n]/.test(script)) {
    if (await call(`${key}={};gma.echo('${prefix}READY')`) !== 'READY') throw new Error('控台操作准备失败');
    const bytes = Buffer.from(script);
    for (let offset = 0; offset < bytes.length; offset += 128) {
      if (await call(`${decode}${key}[#${key}+1]=unhex('${bytes.subarray(offset, offset + 128).toString('hex')}');gma.echo('${prefix}READY')`) !== 'READY') throw new Error('控台操作传输未确认');
    }
    command = `local s=table.concat(${key});${key}=nil;assert(load(s,'tblink_cue','t'))()`;
  }
  const result = await call(command);
  if (!result.startsWith('OK:')) throw new Error(`控台操作未完成：${result.slice(4)}`);
  return result.slice(3);
}
