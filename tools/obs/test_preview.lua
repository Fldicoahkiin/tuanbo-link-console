-- Run under the LuaJIT used by OBS, with a fake source API (no live OBS mutations).
local clock, tick, request = 0, nil, nil
local increments, decrements, releases = 0, 0, 0
local camera = { kind = 'dshow_input' }
local media = { kind = 'ffmpeg_source' }
local source_path = arg[1]
local status_error = nil
script_path = function() return 'fixture/' end
obslua = {
    os_gettime_ns = function() return clock * 1000000000 end,
    obs_data_create_from_json = function() return request end,
    obs_data_create_from_json_file = function() return request end,
    obs_data_save_json = function(data) status_error = data.error; return true end,
    obs_data_create = function() return {} end,
    obs_data_set_int = function(data, key, value) data[key] = value end,
    obs_data_set_string = function(data, key, value) data[key] = value end,
    obs_data_get_json = function(data) return data.error end,
    script_log = function() end,
    LOG_ERROR = 400,
    obs_data_get_string = function(data, key) return data[key] or '' end,
    obs_data_get_array = function(data, key) return data[key] end,
    obs_data_array_count = function(data) return #data end,
    obs_data_array_item = function(data, i) return data[i + 1] end,
    obs_data_array_release = function() end,
    obs_data_release = function() end,
    obs_get_source_by_name = function(name) return name == 'camera' and camera or media end,
    obs_source_get_unversioned_id = function(source) return source.kind end,
    obs_source_inc_showing = function() increments = increments + 1 end,
    obs_source_dec_showing = function() decrements = decrements + 1 end,
    obs_source_release = function() releases = releases + 1 end,
    obs_source_removed = function(source) return source.removed == true end,
    timer_add = function(callback) tick = callback end,
    timer_remove = function(callback) assert(callback == tick) end
}
local load = assert(loadfile(source_path))
io.open = function(path, mode)
    if mode == 'wb' then return { write = function(self, value) status_error = value end, close = function() end } end
    if not request then return nil end
    return { read = function() return '{}' end, close = function() end }
end
load()
script_load()
assert(status_error == '', 'Loaded bridge must report ready without a fake nil error')
local function pulse(nonce, session, name)
    request = { session = session or 'one', sources = {{ name = name or 'camera', nonce = nonce }} }
    tick()
end
pulse('stale')
assert(increments == 0, 'Stale files must not start capture at script load')
pulse('stale')
assert(increments == 0)
pulse('live')
assert(increments == 1)
clock = 1
pulse('next')
assert(increments == 1, 'Heartbeat must not accumulate showing references')
clock = 4
tick()
assert(decrements == 1 and releases == 1)
tick()
assert(increments == 1, 'Expired file must not reactivate capture')
pulse('resume')
assert(increments == 2)
pulse('new', 'two')
assert(decrements == 2, 'Session change must release previous references')
pulse('newer', 'two')
assert(increments == 3)
camera.removed = true
tick()
assert(decrements == 3, 'Removed source must be released')
camera.removed = false
pulse('a', 'two', 'media')
pulse('b', 'two', 'media')
assert(increments == 3, 'Preview must not start media playback')
pulse('final')
pulse('final2')
assert(increments == 4)
script_unload()
assert(decrements == 4, 'Unload must release every held source')
assert(status_error == 'OBS 预览脚本已卸载')
print('OBS preview Lua lifecycle: PASS')
