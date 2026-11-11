// The part of fengari (a Lua 5.3 interpreter in JavaScript, MIT, development only) the bridge tests use.
declare module 'fengari' {
  export type LuaState = { readonly __luaState: unique symbol };
  export const lua: {
    LUA_OK: number;
    lua_pcall(L: LuaState, nargs: number, nresults: number, errfunc: number): number;
    lua_pushstring(L: LuaState, value: Uint8Array): void;
    lua_setglobal(L: LuaState, name: Uint8Array): void;
    lua_getglobal(L: LuaState, name: Uint8Array): number;
    lua_tolstring(L: LuaState, index: number): Uint8Array | null;
    lua_settop(L: LuaState, index: number): void;
    lua_gettop(L: LuaState): number;
  };
  export const lauxlib: {
    luaL_newstate(): LuaState;
    luaL_loadbuffer(L: LuaState, buffer: Uint8Array, size: number | null, name: Uint8Array): number;
  };
  export const lualib: { luaL_openlibs(L: LuaState): void };
  export function to_luastring(value: string): Uint8Array;
}
