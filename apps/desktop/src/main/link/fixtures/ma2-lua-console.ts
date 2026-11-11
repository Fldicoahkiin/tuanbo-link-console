import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lauxlib, lua, lualib, to_luastring, type LuaState } from 'fengari';

const fake = readFileSync(fileURLToPath(new URL('./ma2-fake-console.lua', import.meta.url)));
/** The bridge exactly as the application ships it, and the copy from before it answered step by step. */
export const bridgeSource = readFileSync(fileURLToPath(new URL('../../../../../../tools/ma2/tblink_bridge.lua', import.meta.url)), 'utf8');
export const singleRunBridgeSource = readFileSync(fileURLToPath(new URL('./tblink_bridge.single-run.lua', import.meta.url)), 'utf8');

export type FakeObject = { xml?: string; label?: string; name?: string; number?: string; cues?: Array<{ number: string; label: string }> };

/** Runs the real bridge plugin in a Lua 5.3 interpreter against `ma2-fake-console.lua`, answering
 * Telnet `Lua "…"` lines the way the console's monitor port does. Only for tests. */
export class Ma2LuaConsole {
  private readonly L: LuaState = lauxlib.luaL_newstate();
  /** Every Telnet line this console received, in order. */
  readonly lines: string[] = [];
  /** The console commands each Telnet line ran: what one plugin step did on the console. */
  readonly perLine: Array<{ line: string; commands: string[] }> = [];
  /** Runs before each Telnet line executes, so a test can change the console between two lines. */
  beforeLine: ((line: string, index: number) => void) | null = null;
  /** `source: null` is a console with no bridge running yet, for the installer. */
  constructor(source: string | null = bridgeSource, mode: 'network' | 'file' = 'network') {
    lualib.luaL_openlibs(this.L);
    this.load(fake, '=ma2-fake-console');
    if (source !== null) this.lua(`FAKE.main = assert(load(SOURCE, 'tblink_bridge', 't'))(); FAKE.main(MODE)`, { SOURCE: source, MODE: mode === 'network' ? 'network' : 'local' });
  }
  private load(code: Uint8Array, name: string): Buffer[] {
    const top = lua.lua_gettop(this.L);
    if (lauxlib.luaL_loadbuffer(this.L, code, null, to_luastring(name)) !== lua.LUA_OK || lua.lua_pcall(this.L, 0, -1, 0) !== lua.LUA_OK) {
      const message = Buffer.from(lua.lua_tolstring(this.L, -1) ?? new Uint8Array()).toString('utf8');
      lua.lua_settop(this.L, top);
      throw new Error(`Lua: ${message}`);
    }
    const results: Buffer[] = [];
    for (let index = top + 1; index <= lua.lua_gettop(this.L); index++) results.push(Buffer.from(lua.lua_tolstring(this.L, index) ?? new Uint8Array()));
    lua.lua_settop(this.L, top);
    return results;
  }
  /** Runs test code in the console's Lua state; `strings` become globals first, byte for byte. */
  lua(code: string, strings: Record<string, string | Buffer> = {}): Buffer[] {
    for (const [name, value] of Object.entries(strings)) {
      lua.lua_pushstring(this.L, typeof value === 'string' ? to_luastring(value) : new Uint8Array(value));
      lua.lua_setglobal(this.L, to_luastring(name));
    }
    return this.load(to_luastring(code), '=test');
  }
  set(address: string, object: FakeObject): void {
    const cues = (object.cues ?? []).map((cue, index) => `{number=CUE_NUMBER_${index},label=CUE_LABEL_${index}}`).join(',');
    const strings: Record<string, string> = { ADDRESS: address, XML: object.xml ?? '', LABEL: object.label ?? '', NAME: object.name ?? '', NUMBER: object.number ?? address.replace(/^.* /, '') };
    for (const [index, cue] of (object.cues ?? []).entries()) { strings[`CUE_NUMBER_${index}`] = cue.number; strings[`CUE_LABEL_${index}`] = cue.label; }
    this.lua(`FAKE.objects[ADDRESS] = {xml=${object.xml === undefined ? 'nil' : 'XML'},label=LABEL,name=NAME,number=NUMBER${object.cues ? `,cues={${cues}}` : ''}}`, strings);
  }
  remove(address: string): void { this.lua('FAKE.objects[ADDRESS] = nil', { ADDRESS: address }); }
  /** Commands the bridge ran on the console with `gma.cmd`, in order. */
  commands(): string[] {
    const [joined] = this.lua(`return table.concat(FAKE.log, '\\n')`);
    const text = joined?.toString('utf8') ?? '';
    return text ? text.split('\n') : [];
  }
  /** Names of the files left in importexport, sorted. */
  exportFiles(): string[] {
    const [joined] = this.lua(`local names = {}; for path in pairs(FAKE.files) do local name = path:match('^/fake/importexport/(.*)$'); if name then names[#names + 1] = name end end; table.sort(names); return table.concat(names, '\\n')`);
    const text = joined?.toString('utf8') ?? '';
    return text ? text.split('\n') : [];
  }
  file(path: string): Buffer | null {
    const [exists, content] = this.lua(`local data = FAKE.files[PATH]; return data and 'yes' or 'no', data or ''`, { PATH: path });
    return exists?.toString() === 'yes' ? content ?? Buffer.alloc(0) : null;
  }
  /** Everything the console holds — files and objects — so two runs can be compared byte for byte. */
  state(): Buffer {
    const [dump] = this.lua(`local out = {}
      local function keys(t) local list = {}; for key in pairs(t) do list[#list + 1] = key end; table.sort(list); return list end
      for _, path in ipairs(keys(FAKE.files)) do out[#out + 1] = 'file ' .. path .. ' ' .. #FAKE.files[path] .. '\\n' .. FAKE.files[path] end
      for _, address in ipairs(keys(FAKE.objects)) do local o = FAKE.objects[address]; out[#out + 1] = 'object ' .. address .. ' ' .. tostring(o.label) .. ' ' .. tostring(o.name) .. '\\n' .. tostring(o.xml) end
      return table.concat(out, '\\n')`);
    return dump ?? Buffer.alloc(0);
  }
  /** The local onPC file bridge: hands one request file to the plugin's poll timer and returns its response file. */
  poll(request: string): string | null {
    const [response] = this.lua(`FAKE.files[FAKE.vars.PATH .. '/temp/tblink_bridge_request.txt'] = REQUEST
      for _, timer in ipairs(FAKE.timers) do timer.fn() end
      local response = FAKE.files[FAKE.vars.PATH .. '/temp/tblink_bridge_response.txt']; FAKE.files[FAKE.vars.PATH .. '/temp/tblink_bridge_response.txt'] = nil
      return response`, { REQUEST: request });
    return response?.length ? response.toString('utf8') : null;
  }
  /** Telnet `command` as `Ma2Telnet` offers it: runs one `Lua "…"` line and answers with what it echoed. */
  command = (line: string, match: (text: string) => string | null): Promise<string> => {
    const code = /^Lua "([\s\S]*)"$/.exec(line)?.[1];
    if (code === undefined) return Promise.reject(new Error(`Not a Lua line: ${line.slice(0, 80)}`));
    this.beforeLine?.(line, this.lines.length);
    this.lines.push(line);
    const before = this.commands().length;
    const [echoed] = this.lua(`FAKE.echo = {}; ${code}\nreturn table.concat(FAKE.echo, '\\r\\n')`);
    this.perLine.push({ line, commands: this.commands().slice(before) });
    const text = `${line}\r\n${echoed?.toString('utf8') ?? ''}\r\n`;
    try {
      const result = match(text);
      return result === null ? Promise.reject(new Error(`No reply in: ${text.slice(0, 200)}`)) : Promise.resolve(result);
    } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
  };
}
