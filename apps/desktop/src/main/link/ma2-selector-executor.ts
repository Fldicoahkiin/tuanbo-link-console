import { randomBytes } from 'node:crypto';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import type { Ma2ShowSource } from './ma2-show-probe';
import type { Ma2Telnet } from './ma2-telnet';

/** Only the marked selector's own executor may be restored to timecode-driven playback. */
export async function repairMa2SelectorExecutor(connection: Pick<Ma2Telnet, 'command'>, source: Ma2ShowSource, number: number, marker: string,
  gate: () => void): Promise<{ address: string; file: string } | null> {
  if (!Number.isSafeInteger(number) || number < 1 || number > 99999) throw new Error('控台选曲编号无效');
  const file = `tblink_library_${randomBytes(16).toString('hex')}`;
  const body = `
    assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(source.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(source.generation)},'Show or session changed')
    local o=gma.show.getobj
    for _,k in ipairs({'Timecode','Sequence'}) do local h=assert(o.handle(k..' ${number}'));assert(gma.show.property.get(h,'Info')==${ma2LuaString(marker)},'Selector ownership changed') end
    local function export(k,suffix)
      local name='${file}'..suffix
      local path=gma.show.getvar('PATH')..'/importexport/'..name..'.xml'
      gma.cmd('Export '..k..' '..name..' /o')
      local f=assert(io.open(path,'rb'));local xml=f:read('*a');f:close()
      if suffix~='' then os.remove(path) end
      return xml
    end
    local object=assert(export('Timecode ${number}','_tc'):match('<Track%s[^>]*>%s*(<Object[%s>].-</Object>)'),'Selector track changed')
    local page,slot=object:match('<No>%s*30%s*</No>%s*<No>%s*1%s*</No>%s*<No>%s*(%d+)%s*</No>%s*<No>%s*(%d+)%s*</No>')
    assert(page and slot,'Selector executor changed')
    local address=tonumber(page)..'.'..tonumber(slot);local key='Executor '..address
    local function block(suffix) return assert(export(key,suffix):match('(<Exec%s[^>]*>.-</Exec>)'),'Executor export unavailable') end
    local before=block('_check')
    local assigned=assert(before:match('<Assignment[%s>](.-)</Assignment>'))
    assert(tonumber(assigned:match('<No>%s*25%s*</No>%s*<No>%s*1%s*</No>%s*<No>%s*(%d+)%s*</No>'))==${number},'Selector assignment changed')
    local function playback(s) return assert(s:match('<Playback%s[^>]*>'),'Executor playback unavailable') end
    local flags=playback(before)
    local chaser=flags:find(' chaser="true"',1,true)
    local disabled=flags:find(' cmd_disable="true"',1,true)
    if not chaser and not disabled then return 'ready' end
    assert(block('')==before,'Executor changed before write')
    if chaser then gma.cmd('Assign '..key..' /Chaser=Off') end
    if disabled then gma.cmd('Assign '..key..' /CmdDisable=Off') end
    local after=block('_verify')
    local function clean(s)
      return (s:gsub('<Playback%s[^>]*>',function(tag)
        if disabled then tag=tag:gsub(' cmd_disable="%a+"','') end
        -- MA2 exports different mode-specific fields for chasers and cue lists.
        if chaser then
          for _,attr in ipairs({'chaser','chaser_loop_mode','chaser_trigger','chaser_run_mode','wrap_around','restart_mode','rate_master'}) do
            tag=tag:gsub(' '..attr..'="[^"]*"','')
          end
        end
        return tag
      end))
    end
    assert((not chaser or playback(after):find(' chaser="false"',1,true)) and (not disabled or playback(after):find(' cmd_disable="false"',1,true)) and clean(before)==clean(after),'Executor playback settings not confirmed')
    return address`;
  const result = await runMa2GuardedLua(connection, body, gate);
  if (result === 'ready') return null;
  if (!/^[1-9]\d{0,4}\.[1-9]\d{0,4}$/.test(result)) throw new Error('控台没有确认选曲执行器的命令设置');
  return { address: result, file };
}
