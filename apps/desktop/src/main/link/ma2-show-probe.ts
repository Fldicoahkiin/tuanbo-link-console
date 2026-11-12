import { randomBytes } from 'node:crypto';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';

/** The Show the console has loaded, the running bridge's session and the console version: the values the
 * plugin puts on every directory it exports (`tblink_bridge.lua`, PAGES and LISTSEQ). */
export type Ma2ShowSource = { show: string; generation: string; version: string };

/** One short command, not a plugin transaction: it goes ahead of queued plugin steps and never waits behind a
 * whole sync. Hex keeps non-ASCII names intact; the H keeps an empty value parseable. No $, |, ^ or double quotes,
 * which the native command line would consume. */
export async function readMa2ShowSource(connection: Pick<Ma2Telnet, 'command'>): Promise<Ma2ShowSource> {
  const marker = `TBLINK_SHOWCHECK_${randomBytes(16).toString('hex')}`;
  const script = `local function h(v)return 'H'..(tostring(v or ''):gsub('.',function(b)return string.format('%02x',string.byte(b))end))end;gma.echo('${marker}:'..h(gma.show.getvar('SHOWFILE'))..','..h(TBLINK_BRIDGE_GENERATION)..','..h(gma.show.getvar('VERSION')))`;
  const reply = await connection.command(`Lua "${script}"`, text => ma2ResponseLine(text, `${marker}:`), undefined, 'playback');
  return parseMa2ShowSource(reply);
}

export function parseMa2ShowSource(reply: string): Ma2ShowSource {
  const match = /^H((?:[0-9a-f]{2})*),H((?:[0-9a-f]{2})*),H((?:[0-9a-f]{2})*)$/.exec(reply);
  if (!match) throw new Error('控台返回的 Show 信息无法识别，实时状态没有更新');
  const text = (hex: string | undefined): string => Buffer.from(hex ?? '', 'hex').toString('utf8');
  return { show: text(match[1]), generation: text(match[2]), version: text(match[3]) };
}

/** The console answered, and it is not the Show (or bridge session) the page was read from: asking again cannot help. */
export class Ma2ShowSourceChanged extends Error {}

/** Same rule and message as the plugin directory check it replaces (`ma2-executor-page.ts`): a different Show,
 * a restarted bridge or another console version ends the live session. A bridge that is not running says so.
 * `carried`: what the console says now still stands for `expected` (M5: the Telnet line logged in again on the same
 * console and Show, and only the plugin's session changed). */
export async function verifyMa2ShowSource(connection: Pick<Ma2Telnet, 'command'>, expected: Ma2ShowSource, carried: (expected: Ma2ShowSource, actual: Ma2ShowSource) => boolean = () => false): Promise<void> {
  const actual = await readMa2ShowSource(connection);
  if (carried(expected, actual)) return;
  if (!actual.generation) throw new Ma2ShowSourceChanged('控台上的联动台插件没在运行，请重新连接控台；实时状态没有使用旧数据');
  if (actual.show !== expected.show || actual.version !== expected.version || actual.generation !== expected.generation) throw new Ma2ShowSourceChanged('控台的 Show 或连接变了，请重新读取素材；这一页没有使用旧数据');
}
