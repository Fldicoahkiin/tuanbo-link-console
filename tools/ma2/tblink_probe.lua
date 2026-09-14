-- Offline capability probe. Does not issue playback, Store, Import or Delete commands.
-- API names checked against the installed grandMA2 plugin_1.lua reference.
local function start()
    local text = gma.textinput("Timecode object number to inspect", "1")
    if text == nil then return end
    if not string.match(text, "^[1-9]%d*$") then
        error("Timecode number must be a positive integer")
    end
    local object = gma.show.getobj
    local properties = gma.show.property
    local root = object.handle("Timecode " .. text)
    if root == nil then error("Timecode object not found") end
    local report = {
        probe_version = 1,
        timecode_number = text,
        build_date = gma.build_date(),
        build_time = gma.build_time(),
        version_hash = gma.git_version(),
        host_type = gma.network.gethosttype(),
        host_subtype = gma.network.gethostsubtype(),
        network_status = gma.network.getstatus(),
        nodes = {}
    }
    local socket_ok, socket_module = pcall(require, "socket")
    report.socket_available = socket_ok and type(socket_module) == "table"
    report.socket_tcp_available = report.socket_available and type(socket_module.tcp) == "function"
    if not socket_ok then report.socket_error = tostring(socket_module) end
    local visited = {}
    local function visit(handle, path, depth)
        if depth > 32 then error("Object hierarchy exceeds probe depth limit") end
        if #report.nodes >= 100000 then error("Object count exceeds probe limit") end
        if visited[handle] then error("Object hierarchy contains a repeated handle") end
        visited[handle] = true
        local node = {
            path = path,
            class = object.class(handle),
            index = object.index(handle),
            number = object.number(handle),
            name = object.name(handle),
            properties = {}
        }
        local count = properties.amount(handle)
        if type(count) ~= "number" then error("Property enumeration unavailable") end
        for index = 0, count - 1 do
            local name = properties.name(handle, index)
            local value = properties.get(handle, index)
            if name == nil then error("Property name unavailable") end
            node.properties[#node.properties + 1] = { index = index, name = name, value = tostring(value) }
        end
        report.nodes[#report.nodes + 1] = node
        local children = object.amount(handle)
        if type(children) ~= "number" then error("Child enumeration unavailable") end
        for index = 0, children - 1 do
            local child = object.child(handle, index)
            if child == nil then error("Child object unavailable") end
            visit(child, path .. "/" .. tostring(index), depth + 1)
        end
    end
    visit(root, "Timecode " .. text, 0)
    local filename = "tblink_probe_" .. text .. "_" .. tostring(math.floor(gma.gettime() * 1000)) .. ".json"
    gma.export_json(filename, report)
    gma.feedback("Probe export requested: " .. filename .. " (verify file exists in importexport)")
end

return start
