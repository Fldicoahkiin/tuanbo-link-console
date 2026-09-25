-- Local onPC bridge. Start once from a plugin; stop by running this plugin again.
-- Requests are data, never executable Lua. Only one explicitly addressed Timecode is touched.
local active = false
local last = ''
local generation = tostring(gma.gettime())
_G.TBLINK_BRIDGE_GENERATION = generation
local root = gma.show.getvar('PATH')
local request_file = root .. '/temp/tblink_bridge_request.txt'
local processing_file = root .. '/temp/tblink_bridge_processing_' .. generation .. '.txt'
local response_file = root .. '/temp/tblink_bridge_response.txt'
local function read(path)
  local file = io.open(path, 'rb')
  if not file then return nil end
  local data = file:read(33554433)
  file:close()
  assert(#data <= 33554432, 'Bridge file exceeds limit')
  return data
end
local function write(path, data)
  local file = assert(io.open(path, 'wb'))
  assert(file:write(data))
  assert(file:close())
end
local function canonical(xml)
  -- Export timestamps are not object edits. Everything else is compared conservatively.
  local result = xml:gsub('(<MA[^>]*>%s*)<Info[^>]*/>', '%1')
  return result
end
local function export(tc, name)
  gma.cmd('Export Timecode ' .. tc .. ' "' .. name .. '" /o')
  return assert(read(root .. '/importexport/' .. name .. '.xml'), 'Export unavailable')
end
local function references(xml)
  local numbers, seen = {}, {}
  for cue in xml:gmatch('<Cue[^>]*>(.-)</Cue>') do
    local address = {}
    for value in cue:gmatch('<No>%s*(%d+)%s*</No>') do address[#address + 1] = value end
    assert(#address == 3 and address[1] == '1', 'Unsupported Cue reference')
    local number = tonumber(address[2])
    assert(number >= 1 and number <= 99999, 'Invalid Sequence reference')
    if not seen[number] then seen[number] = true; numbers[#numbers + 1] = number end
  end
  return numbers
end
local function snapshot(tc, id, additional)
  local xml = export(tc, 'tblink_snapshot_' .. id)
  local numbers, seen = references(xml), {}
  for _, number in ipairs(numbers) do seen[number] = true end
  for _, number in ipairs(additional or {}) do
    assert(number >= 1 and number <= 99999 and number == math.floor(number), 'Invalid additional Sequence')
    if not seen[number] then seen[number] = true; numbers[#numbers + 1] = number end
  end
  table.sort(numbers)
  local parts = {}
  for _, number in ipairs(numbers) do
    assert(gma.show.getobj.handle('Sequence ' .. number), 'Referenced Sequence is missing')
    local name = 'tblink_sequence_' .. id .. '_' .. number
    gma.cmd('Export Sequence ' .. number .. ' "' .. name .. '" /o')
    local full = assert(read(root .. '/importexport/' .. name .. '.xml'), 'Sequence export unavailable')
    local object = assert(full:match('(<Sequ%s.-</Sequ>)'), 'Sequence XML unavailable')
    parts[#parts + 1] = object
    -- Verify references were not edited while assembling the snapshot.
    gma.cmd('Export Sequence ' .. number .. ' "' .. name .. '_verify" /o')
    local check = assert(read(root .. '/importexport/' .. name .. '_verify.xml'))
    assert(canonical(full) == canonical(check), 'Sequence changed during snapshot')
  end
  assert(canonical(xml) == canonical(export(tc, 'tblink_snapshot_verify_' .. id)), 'Timecode changed during snapshot')
  local result, replaced = xml:gsub('</MA>%s*$', function() return table.concat(parts, '\n') .. '\n</MA>' end)
  assert(replaced == 1 and #result <= 33554432, 'Snapshot XML invalid or too large')
  return result
end
local function process(data)
  local id, op, target, size, body = data:match('^([a-f0-9]+)\n([A-Z]+)\n(%d+)\n(%d+)\n(.*)$')
  assert(id and #id == 32 and id ~= last, 'Invalid or already processed request')
  last = id
  local ok, result = pcall(function()
    local tc = tonumber(target)
    assert(tc and tc >= 1 and tc <= 99999 and tc == math.floor(tc), 'Invalid Timecode')
    assert(#body == tonumber(size), 'Request length mismatch')
    if op == 'PING' then return gma.show.getvar('VERSION') or 'unknown' end
    if op == 'LIST' or op == 'LISTSEQ' then
      assert(body == '', 'Directory request must be empty')
      local obj = gma.show.getobj
      local pool = assert(obj.handle(op == 'LISTSEQ' and 'Sequence' or 'Timecode'), 'Object pool unavailable')
      local count = assert(obj.amount(pool), 'Timecode enumeration unavailable')
      assert(count >= 0 and count <= 100000, 'Timecode directory exceeds limit')
      local function quote(value)
        return '"' .. tostring(value):gsub('[%z\1-\31\\"]', function(char)
          return string.format('\\u%04x', string.byte(char))
        end) .. '"'
      end
      local entries, seen = {}, {}
      for index = 0, count - 1 do
        -- Native pools are sparse: amount is the indexed span, not occupied slots.
        local child = obj.child(pool, index)
        if child then
          local number = tonumber(obj.number(child))
          assert(number and number >= 1 and number <= 99999 and number == math.floor(number) and not seen[number], 'Invalid Timecode directory number')
          seen[number] = true
          entries[#entries + 1] = '{"target":' .. number .. ',"name":' .. quote(assert(obj.name(child), 'Timecode name unavailable')) .. '}'
          assert(#entries <= 10000, 'Occupied Timecode directory exceeds limit')
        end
      end
      assert(obj.amount(pool) == count, 'Timecode directory changed during read')
      return '{"show":' .. quote(assert(gma.show.getvar('SHOWFILE'), 'Show identity unavailable')) .. ',"generation":' .. quote(generation) .. ',"version":' .. quote(assert(gma.show.getvar('VERSION'))) .. ',"entries":[' .. table.concat(entries, ',') .. ']}'
    end
    if op == 'SEQUENCE' then
      assert(body == '', 'Sequence request must be empty')
      assert(gma.show.getobj.handle('Sequence ' .. tc), 'Sequence missing')
      local name = 'tblink_library_' .. id
      gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '" /o')
      local xml = assert(read(root .. '/importexport/' .. name .. '.xml'), 'Sequence export unavailable')
      gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '_verify" /o')
      assert(canonical(xml) == canonical(assert(read(root .. '/importexport/' .. name .. '_verify.xml'))), 'Sequence changed during read')
      return xml
    end
    if op == 'EXECUTOR' then
      assert(body:match('^[1-9]%d*$') and tonumber(body) <= 99999, 'Invalid Executor number')
      local address = 'Executor ' .. tc .. '.' .. body
      local handle = assert(gma.show.getobj.handle(address), 'Executor does not exist')
      local executor_name = assert(gma.show.getobj.name(handle), 'Executor name unavailable')
      local name = 'tblink_executor_' .. id
      gma.cmd('Export ' .. address .. ' "' .. name .. '" /o')
      local xml = assert(read(root .. '/importexport/' .. name .. '.xml'), 'Executor export unavailable')
      assert(gma.show.getobj.handle(address), 'Executor disappeared during read')
      gma.cmd('Export ' .. address .. ' "' .. name .. '_verify" /o')
      local check = assert(read(root .. '/importexport/' .. name .. '_verify.xml'), 'Executor verification unavailable')
      assert(canonical(xml) == canonical(check), 'Executor changed during read')
      assert(gma.show.getobj.name(assert(gma.show.getobj.handle(address))) == executor_name, 'Executor name changed during read')
      local escaped = executor_name:gsub('&', '&amp;'):gsub('"', '&quot;'):gsub('<', '&lt;'):gsub('>', '&gt;'):gsub('\r', '&#13;'):gsub('\n', '&#10;'):gsub('\t', '&#9;')
      local result, count = xml:gsub('<Exec%s', function() return '<Exec tblink_executor_name="' .. escaped .. '" ' end)
      assert(count == 1, 'Executor export must contain one object')
      return result
    end
    if op == 'CREATE' then
      assert(not gma.show.getobj.handle('Timecode ' .. tc), 'Timecode already exists; creation refused')
      local length, desired = body:match('^(%d+)\n(.*)$')
      assert(length == '0' and #desired > 0 and #desired <= 65536, 'Invalid creation payload')
      assert(not desired:find('<!DOCTYPE') and not desired:find('<!ENTITY') and not desired:find('<Track') and not desired:find('<Sequ'), 'New Timecode must be empty')
      local index = desired:match('<Timecode%s[^>]-index="(%d+)"')
      assert(tonumber(index) == tc - 1, 'Creation target mismatch')
      local name = 'tblink_create_' .. id
      write(root .. '/importexport/' .. name .. '.xml', desired)
      assert(not gma.show.getobj.handle('Timecode ' .. tc), 'Timecode appeared before creation')
      gma.cmd('Import "' .. name .. '.xml" At Timecode ' .. tc .. ' /nc')
      assert(gma.show.getobj.handle('Timecode ' .. tc), 'Timecode creation unconfirmed')
      return export(tc, 'tblink_created_' .. id)
    end
    assert(gma.show.getobj.handle('Timecode ' .. tc), 'Timecode does not exist')
    if op == 'READ' then return export(tc, 'tblink_read_' .. id) end
    if op == 'SNAPSHOT' then return snapshot(tc, id) end
    if op == 'SCOPE' then
      assert(#body > 0 and not body:find('[^%d,]') and not body:find(',,') and body:sub(1, 1) ~= ',' and body:sub(-1) ~= ',', 'Invalid Sequence scope')
      local additional, seen = {}, {}
      for value in body:gmatch('[^,]+') do
        local number = tonumber(value)
        assert(number and number >= 1 and number <= 99999 and not seen[number], 'Invalid Sequence scope')
        seen[number] = true; additional[#additional + 1] = number
      end
      return snapshot(tc, id, additional)
    end
    assert(op == 'APPLY' or op == 'SYNC', 'Unknown operation')
    local length, rest = body:match('^(%d+)\n(.*)$')
    assert(length, 'Missing expected snapshot')
    length = tonumber(length)
    local expected = rest:sub(1, length)
    local desired = rest:sub(length + 1)
    assert(#desired > 0 and not desired:find('<!DOCTYPE') and not desired:find('<!ENTITY'), 'Invalid XML')
    if op == 'SYNC' then
      assert(canonical(snapshot(tc, id .. '_preflight', references(desired))) == canonical(expected), 'Timecode or Sequence changed after preview')
    end
    local backup = export(tc, 'tblink_backup_' .. id)
    if op == 'SYNC' then
      assert(backup:match('(<Timecode%s.-</Timecode>)') == expected:match('(<Timecode%s.-</Timecode>)'), 'Timecode changed before write')
    else
      assert(canonical(backup) == canonical(expected), 'Timecode changed after preview')
    end
    local name = 'tblink_write_' .. id
    write(root .. '/importexport/' .. name .. '.xml', desired)
    gma.cmd('Import "' .. name .. '.xml" At Timecode ' .. tc .. ' /o /nc')
    return export(tc, 'tblink_verify_' .. id)
  end)
  local output = tostring(result)
  return id .. '\n' .. (ok and 'OK' or 'ERROR') .. '\n' .. #output .. '\n' .. output
end
local function poll()
  if not active or _G.TBLINK_BRIDGE_GENERATION ~= generation then return end
  local claimed = os.rename(request_file, processing_file)
  if not claimed then return end
  local data = read(processing_file)
  assert(os.remove(processing_file), 'Could not release processed request')
  if data then write(response_file, process(data)) end
end
-- Telnet carries bounded hexadecimal data, never source code supplied by a project.
-- No LuaSocket dependency. Each command has its own response token.
local network = nil
local function hex(data) return (data:gsub('.', function(c) return string.format('%02x', string.byte(c)) end)) end
_G.TBLINK_NET = function(token, action, id, a, b, c)
  if not token:match('^[a-f0-9]+$') or #token ~= 32 then return end
  local ok, result = pcall(function()
    assert(active and _G.TBLINK_BRIDGE_GENERATION == generation, 'Bridge is stopped')
    assert(type(id) == 'string' and #id == 32 and id:match('^[a-f0-9]+$'), 'Invalid request identity')
    if action == 'begin' then
      assert(id ~= last, 'Request already processed')
      assert(a == 'PING' or a == 'LIST' or a == 'LISTSEQ' or a == 'SEQUENCE' or a == 'READ' or a == 'SNAPSHOT' or a == 'SCOPE' or a == 'APPLY' or a == 'SYNC' or a == 'CREATE' or a == 'EXECUTOR', 'Invalid operation')
      assert(type(b) == 'number' and b >= 1 and b <= 99999 and b == math.floor(b), 'Invalid target')
      assert(type(c) == 'number' and c >= 0 and c <= 33554432 and c == math.floor(c), 'Invalid payload size')
      assert(not network or gma.gettime() > network.expires, 'Another network request is pending')
      network = { id = id, op = a, target = b, size = c, bytes = 0, chunks = {}, expires = gma.gettime() + 120 }
      return 'ACK'
    end
    assert(network and network.id == id and gma.gettime() <= network.expires, 'Network request expired or mismatched')
    network.expires = gma.gettime() + 120
    if action == 'chunk' then
      assert(not network.done and a == #network.chunks + 1, 'Invalid chunk order')
      assert(type(b) == 'string' and #b > 0 and #b <= 512 and #b % 2 == 0 and not b:find('[^a-f0-9]'), 'Invalid chunk')
      local data = b:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
      assert(network.bytes + #data <= network.size, 'Payload exceeds declared size')
      network.chunks[#network.chunks + 1] = data; network.bytes = network.bytes + #data
      return 'ACK'
    end
    if action == 'run' then
      assert(not network.done and network.bytes == network.size, 'Incomplete or already executed request')
      network.done = true
      local body = table.concat(network.chunks); network.chunks = nil
      network.response = process(id .. '\n' .. network.op .. '\n' .. network.target .. '\n' .. #body .. '\n' .. body)
      assert(#network.response <= 33554500, 'Response exceeds limit')
      return 'DONE:' .. #network.response
    end
    if action == 'read' then
      assert(network.done and network.response, 'No response available')
      assert(type(a) == 'number' and a >= 0 and a < #network.response and a == math.floor(a), 'Invalid response offset')
      return 'DATA:' .. hex(network.response:sub(a + 1, a + 256))
    end
    if action == 'release' then network = nil; return 'ACK' end
    error('Unknown network action')
  end)
  gma.echo('TBLINK_RPC_' .. token .. ':' .. (ok and result or 'ERR:' .. hex(tostring(result))))
end
local function main(mode)
  if active then active = false; _G.TBLINK_BRIDGE_READY = false; gma.feedback('TBLINK bridge stopped'); return end
  if mode == 'network' then
    active = true
    _G.TBLINK_BRIDGE_READY = true
    return
  end
  -- A restart must not replay a previously sent write with an uncertain outcome.
  os.rename(request_file, root .. '/temp/tblink_bridge_abandoned_' .. generation .. '.txt')
  active = true
  _G.TBLINK_BRIDGE_READY = true
  gma.timer(poll, 0.1, 0)
  gma.feedback('TBLINK local onPC bridge ready')
end
return main
