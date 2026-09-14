"""Execute the Lua lifecycle fixture using the installed OBS LuaJIT, without opening OBS."""
import ctypes
import os
from pathlib import Path

directory = Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'obs-studio/bin/64bit'
with os.add_dll_directory(str(directory)):
    lua = ctypes.CDLL(str(directory / 'lua51.dll'))
lua.luaL_newstate.restype = ctypes.c_void_p
lua.luaL_openlibs.argtypes = [ctypes.c_void_p]
lua.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
lua.lua_pcall.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int]
lua.lua_tolstring.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
lua.lua_tolstring.restype = ctypes.c_char_p
lua.lua_close.argtypes = [ctypes.c_void_p]
state = lua.luaL_newstate()
try:
    lua.luaL_openlibs(state)
    root = Path(__file__).resolve().parent
    source = (root / 'tblink_preview.lua').read_text(encoding='utf-8')
    fixture = (root / 'test_preview.lua').read_text(encoding='utf-8')
    code = "arg = {'fixture'}; loadfile = function() return assert(loadstring([==[" + source + "]==])) end;\n" + fixture
    status = lua.luaL_loadstring(state, code.encode('utf-8'))
    if not status:
        status = lua.lua_pcall(state, 0, 0, 0)
    if status:
        raise RuntimeError(lua.lua_tolstring(state, -1, None).decode('utf-8'))
finally:
    lua.lua_close(state)
