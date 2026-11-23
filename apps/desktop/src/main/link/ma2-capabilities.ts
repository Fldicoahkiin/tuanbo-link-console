import { randomBytes } from 'node:crypto';
import { MA2_SONG_TIMECODE_SLOT } from '@tb/core/link';
import type { Ma2Capabilities } from '@tb/schema';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';

/** Read the MIDI TC assignment of the station answering Telnet. MA 3D can have the same IP. */
export const ma2MidiInputProbe = [
  'local function input()',
  "local o,p=gma.show.getobj,gma.show.property; local ip=gma.show.getvar('HOSTIP'); local root=o.handle('NetConfig'); local found",
  "if not ip or ip=='' then return '?' end",
  'for i=0,o.amount(root)-1 do local group=o.child(root,i)',
  'for j=0,o.amount(group)-1 do local n=o.child(group,j)',
  "if p.get(n,'IP')==ip and (p.get(n,'Version') or '')~='' then",
  "for k=0,p.amount(n)-1 do if p.name(n,k)=='MIDI TC' then",
  "if found then return '?' end; found=p.get(n,k) or '?'",
  'end end end end end',
  "return found or '?' end",
  "local ok,slot=pcall(input); if not ok then slot='?' end"
].join(' ');

/** One explicit maintenance check. No playback or idle polling uses this command. */
export async function readMa2Capabilities(connection: Pick<Ma2Telnet, 'command'>, version: string): Promise<Ma2Capabilities> {
  const marker = `TBLINK_CAP_${randomBytes(16).toString('hex')}`;
  const fields = "tostring(_VERSION)..':'..tostring(type(TBLINK_NET)=='function')..':'..tostring(type(gma.show.getobj)=='table' and type(gma.show.getobj.handle)=='function')..':'..tostring(type(io)=='table' and type(io.open)=='function')..':'..slot";
  const reply = await connection.command(`Lua "${ma2MidiInputProbe};gma.echo('${marker}:'..${fields})"`, text => ma2ResponseLine(text, `${marker}:`));
  const parts = reply.split(':');
  if (parts.length !== 5 || !parts.slice(1, 4).every(part => part === 'true' || part === 'false')) throw new Error('控台返回的功能信息无法识别');
  const plugin = parts[1] === 'true', objects = parts[2] === 'true', files = parts[3] === 'true';
  const message = plugin && objects && files ? '基本功能可用。请先读取目标 Timecode 检查内容，写入后联动台会再读回确认。'
    : !plugin ? '没有检测到控台插件，请导出插件并在控台上运行后重新检测。' : '这个控台版本缺少需要的功能，无法自动同步。';
  const midiInputSlot = parseMa2MidiInputSlot(parts[4]);
  return { version, lua: parts[0]!, plugin, objects, files, midiInputSlot, message: message + ma2MidiInputMessage(midiInputSlot) };
}

export function parseMa2MidiInputSlot(value: string | undefined): number | null {
  const match = /^TC Slot ([1-8])$/.exec(value ?? '');
  return match ? Number(match[1]) : value?.toLowerCase() === 'off' ? 0 : null;
}

export function ma2MidiInputMessage(slot: number | null): string {
  if (slot === null) return `没有读到这台控台的 MIDI 时码槽。请在接收 MIDI 的站点检查 MIDI TC，歌曲使用 ${MA2_SONG_TIMECODE_SLOT}。`;
  const assignment = slot === 0 ? '已关闭' : `接到 TC Slot ${slot}`;
  const setting = `这台控台的 MIDI TC ${assignment}。`;
  return setting + (`TC Slot ${slot}` === MA2_SONG_TIMECODE_SLOT ? '请在播放时观察该槽的时码是否前进。'
    : `歌曲使用 ${MA2_SONG_TIMECODE_SLOT}。如果 MIDI 接在这台控台，请在 MA Network Configuration 里将 MIDI TC 改为 ${MA2_SONG_TIMECODE_SLOT}。`);
}
