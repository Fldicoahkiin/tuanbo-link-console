-- Local editor preview only. Never changes Program, scene items, filters or outputs.
local obs = obslua
local ffi = require('ffi')
ffi.cdef('unsigned long __stdcall GetCurrentProcessId(void);')
local pid = tonumber(ffi.C.GetCurrentProcessId())
local root = script_path()
local request_path = root .. tostring(pid) .. '.json'
local held = {}
local session = nil
local consumed = {}
local supported = { dshow_input = true, window_capture = true, monitor_capture = true }
local last_status = -10
local last_error = nil

local function report(problem, force)
    local now = obs.os_gettime_ns() / 1000000000
    if not force and now - last_status < 1 and problem == last_error then return end
    last_status = now
    if problem and problem ~= last_error then obs.script_log(obs.LOG_ERROR, problem) end
    last_error = problem
    local data = obs.obs_data_create()
    obs.obs_data_set_int(data, 'version', 1)
    obs.obs_data_set_int(data, 'pid', pid)
    obs.obs_data_set_string(data, 'error', problem or '')
    if not obs.obs_data_save_json(data, root .. tostring(pid) .. '.status.json') then
        obs.script_log(obs.LOG_ERROR, '无法写入预览状态：' .. root)
    end
    obs.obs_data_release(data)
end

local function release(name)
    local item = held[name]
    if item then
        obs.obs_source_dec_showing(item.source)
        obs.obs_source_release(item.source)
        held[name] = nil
    end
end

local function clear()
    for name in pairs(held) do release(name) end
end

local function update()
    local now = obs.os_gettime_ns() / 1000000000
    local data = obs.obs_data_create_from_json_file(request_path)
    if data then
                local next_session = obs.obs_data_get_string(data, 'session')
                if next_session ~= session then clear(); consumed = {}; session = next_session end
                local items = obs.obs_data_get_array(data, 'sources')
                local next_consumed = {}
                if items and next_session ~= '' then
                    for index = 0, math.min(obs.obs_data_array_count(items), 128) - 1 do
                        local entry = obs.obs_data_array_item(items, index)
                        local name = obs.obs_data_get_string(entry, 'name')
                        local nonce = obs.obs_data_get_string(entry, 'nonce')
                        local item = held[name]
                        if not item and nonce ~= '' and consumed[name] and consumed[name] ~= nonce then
                            local source = obs.obs_get_source_by_name(name)
                            if source then
                                if supported[obs.obs_source_get_unversioned_id(source)] then
                                    obs.obs_source_inc_showing(source)
                                    item = { source = source, nonce = '', seen = now }
                                    held[name] = item
                                else obs.obs_source_release(source) end
                            end
                        end
                        if item and item.nonce ~= nonce then item.nonce = nonce; item.seen = now end
                        next_consumed[name] = nonce
                        obs.obs_data_release(entry)
                    end
                end
                if items then obs.obs_data_array_release(items) end
                consumed = next_consumed
                obs.obs_data_release(data)
    end
    for name, item in pairs(held) do
        if now - item.seen > 2 or obs.obs_source_removed(item.source) then release(name) end
    end
end

function script_description()
    return '团播联动台编辑预览。仅保持编辑器正在查看的摄像头、窗口和显示器采集；关闭预览后自动释放，不切换正式场景。仅支持同一电脑上的 OBS。'
end

local function tick()
    local ok, problem = pcall(update)
    if not ok then
        local released, release_error = pcall(clear)
        if not released then problem = tostring(problem) .. '; ' .. tostring(release_error) end
    end
    if ok then report(nil, false) else report(tostring(problem), false) end
end

function script_load()
    report(nil, true)
    obs.timer_add(tick, 100)
end

function script_unload()
    obs.timer_remove(tick)
    clear()
    report('OBS 预览脚本已卸载', true)
end
