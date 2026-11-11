-- A stand-in for the parts of grandMA2 that tools/ma2/tblink_bridge.lua touches, for unit tests.
-- It is not a console emulator: it answers only what the bridge asks, from objects a test puts in
-- FAKE.objects, and records every command. Files live in memory; nothing reaches the disk.
FAKE = { files = {}, objects = {}, log = {}, echo = {}, feedback = {}, timers = {}, after = {}, now = 1000,
  vars = { PATH = '/fake', VERSION = '3.3.4.3', SHOWFILE = 'tblink_fake_show', BUTTONPAGE = '1', FADERPAGE = '1' } }

-- In-memory io.open / os.remove / os.rename, with the return conventions of the real library.
local function reader(data)
  local position = 1
  return {
    read = function(_, count)
      if position > #data and count > 0 then return nil end
      local part = data:sub(position, position + count - 1); position = position + count; return part
    end,
    close = function() return true end
  }
end
io = {
  open = function(path, mode)
    if mode == 'rb' then
      if FAKE.files[path] == nil then return nil, path .. ': No such file or directory', 2 end
      return reader(FAKE.files[path])
    end
    assert(mode == 'wb', 'fake io.open: unsupported mode ' .. tostring(mode))
    local parts = {}
    local file = {}
    file.write = function(self, data) parts[#parts + 1] = data; return self end
    file.close = function() FAKE.files[path] = table.concat(parts); return true end
    return file
  end
}
os = {
  remove = function(path)
    if FAKE.files[path] == nil then return nil, path .. ': No such file or directory', 2 end
    FAKE.files[path] = nil; return true
  end,
  rename = function(from, to)
    if FAKE.files[from] == nil then return nil, from .. ': No such file or directory', 2 end
    FAKE.files[to] = FAKE.files[from]; FAKE.files[from] = nil; return true
  end
}

local function export_path(name) return FAKE.vars.PATH .. '/importexport/' .. name end
-- Pools are listed from the objects present, in number order, as the console's handle pools are.
local function pool(kind)
  local children = {}
  for address, object in pairs(FAKE.objects) do
    if address:match('^' .. kind .. ' %d+$') then children[#children + 1] = object end
  end
  table.sort(children, function(a, b) return tonumber(a.number) < tonumber(b.number) end)
  return { children = children }
end
local function cmd(command)
  FAKE.log[#FAKE.log + 1] = command
  local kind, number, name = command:match('^Export (%a+) ([%d%.]+) "?([%w_]+)"? /o$')
  if kind then
    local object = FAKE.objects[kind .. ' ' .. number]
    -- '@EXPORT@' becomes the command's number, like the export time the console writes into <Info>.
    if object and object.xml then FAKE.files[export_path(name .. '.xml')] = (object.xml:gsub('@EXPORT@', tostring(#FAKE.log))) end
  else
    local file, target = command:match('^Import "([%w_]+%.xml)" At Timecode (%d+) ')
    if file then
      local content = assert(FAKE.files[export_path(file)], 'fake console: import file missing')
      local address = 'Timecode ' .. target
      local object = FAKE.objects[address] or { number = target, name = content:match('<Timecode%s[^>]-name="([^"]*)"') or '' }
      object.xml = FAKE.imported and FAKE.imported(content) or content
      FAKE.objects[address] = object
    else
      local address, label = command:match('^Label (.-) "(.*)"$')
      if address then FAKE.objects[address].label = label end
      local page, page_label = command:match('^Store Page (%d+) "(.*)" /nc$')
      if page then FAKE.objects['Page ' .. page] = { number = page, label = page_label } end
      local sequence, executor = command:match('^Assign Sequence (%d+) At Executor ([%d%.]+) /nc$')
      if sequence then
        FAKE.objects['Executor ' .. executor] = { number = executor:match('%.(%d+)$'), label = '',
          xml = '<MA><Exec><Assignment name="x"><No>25</No><No>1</No><No>' .. sequence .. '</No></Assignment></Exec></MA>' }
      end
    end
  end
  -- A test can change the console right after the n-th command, as an operator or another client would.
  local after = FAKE.after[#FAKE.log]
  if after then after() end
end

gma = {
  cmd = cmd,
  echo = function(text) FAKE.echo[#FAKE.echo + 1] = text end,
  feedback = function(text) FAKE.feedback[#FAKE.feedback + 1] = text end,
  gettime = function() return FAKE.now end,
  timer = function(fn, interval, count) FAKE.timers[#FAKE.timers + 1] = { fn = fn, interval = interval, count = count } end,
  show = {
    getvar = function(name) return FAKE.vars[name] end,
    getobj = {
      handle = function(address)
        if address == 'Timecode' or address == 'Sequence' or address == 'Page' then return pool(address) end
        return FAKE.objects[address]
      end,
      label = function(handle) return handle.label end,
      name = function(handle) return handle.name end,
      number = function(handle) return handle.number end,
      amount = function(handle) return #(handle.children or handle.cues or {}) end,
      child = function(handle, index) return (handle.children or handle.cues)[index + 1] end
    }
  }
}
