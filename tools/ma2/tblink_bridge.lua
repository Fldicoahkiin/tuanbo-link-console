-- Local onPC bridge. Start once from a plugin; stop by running this plugin again.
-- Requests are data, never executable Lua. Only one explicitly addressed Timecode is touched.
local active = false
-- Remove every export a request makes only to read or compare once it is done. Kept: write
-- backups (tblink_backup_, tblink_label_) and a SEQUENCE export requested with body 'keep'.
local remove_scratch = true
local last = ''
local generation = tostring(gma.gettime())
_G.TBLINK_BRIDGE_GENERATION = generation
local root = gma.show.getvar('PATH')
local request_file = root .. '/temp/tblink_bridge_request.txt'
local processing_file = root .. '/temp/tblink_bridge_processing_' .. generation .. '.txt'
local response_file = root .. '/temp/tblink_bridge_response.txt'
local appearance_cache = {}
local function discard(name)
  -- A copy that cannot be removed stays in importexport, as every copy did before this cleanup.
  if remove_scratch then os.remove(root .. '/importexport/' .. name .. '.xml') end
end
local function sequence_appearance(number, handle)
  local now = gma.gettime()
  local cached = appearance_cache[number]
  if cached and cached.handle == handle and cached.show == gma.show.getvar('SHOWFILE') and now - cached.at < 2 then return cached.color end
  local file = 'tblink_appearance_' .. number
  gma.cmd('Export Sequence ' .. number .. ' ' .. file .. ' /o')
  local input = assert(io.open(root .. '/importexport/' .. file .. '.xml', 'rb'), 'Sequence appearance export unavailable')
  -- Appearance belongs to Sequ, before the first Cue. Fixture values never cross the network here.
  local header = input:read(4096) or ''; input:close(); discard(file)
  local before_cue = header:match('^(.-)<Cue') or header
  local color = before_cue:match('<Appearance%s+Color="([a-fA-F0-9]+)"')
  assert(not color or #color == 6, 'Invalid Sequence appearance')
  appearance_cache[number] = {handle=handle,show=gma.show.getvar('SHOWFILE'),at=now,color=color}
  return color
end
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
local function export_scratch(tc, name)
  local xml = export(tc, name); discard(name); return xml
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
  local xml = export_scratch(tc, 'tblink_snapshot_' .. id)
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
    discard(name); discard(name .. '_verify')
  end
  assert(canonical(xml) == canonical(export(tc, 'tblink_snapshot_verify_' .. id)), 'Timecode changed during snapshot')
  discard('tblink_snapshot_verify_' .. id)
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
    if op == 'PAGES' then
      assert(body == '', 'Page directory request must be empty')
      local obj = gma.show.getobj
      local pool = assert(obj.handle('Page'), 'Page pool unavailable')
      local count = assert(obj.amount(pool))
      assert(count <= 10000, 'Page directory exceeds limit')
      local function quote(value) return '"' .. tostring(value):gsub('[%z\1-\31\\"]', function(c) return string.format('\\u%04x', c:byte()) end) .. '"' end
      local entries = {}
      for index = 0, count - 1 do
        local h = obj.child(pool, index)
        if h then
          local number = assert(tonumber(obj.number(h)))
          assert(number >= 1 and number <= 9999 and number == math.floor(number), 'Invalid Page number')
          entries[#entries + 1] = '{"page":' .. number .. ',"name":' .. quote(obj.label(h) or '') .. '}'
        end
      end
      return '{"show":' .. quote(gma.show.getvar('SHOWFILE')) .. ',"generation":' .. quote(generation) .. ',"version":' .. quote(gma.show.getvar('VERSION')) .. ',"buttonPage":' .. assert(tonumber(gma.show.getvar('BUTTONPAGE'))) .. ',"faderPage":' .. assert(tonumber(gma.show.getvar('FADERPAGE'))) .. ',"pages":[' .. table.concat(entries, ',') .. ']}'
    end
    if op == 'PAGE' then
      assert(body == '', 'Page request must be empty')
      local obj = gma.show.getobj
      assert(obj.handle('Page ' .. tc), 'Executor Page does not exist')
      local file = 'tblink_page_' .. id
      gma.cmd('Export Page ' .. tc .. ' ' .. file .. ' /o')
      local xml = assert(read(root .. '/importexport/' .. file .. '.xml'), 'Page export unavailable')
      discard(file)
      local function escape(value) return tostring(value):gsub('&', '&amp;'):gsub('"', '&quot;'):gsub('<', '&lt;'):gsub('>', '&gt;') end
      xml = xml:gsub('<MA%s', function() return '<MA tblink_show="' .. escape(gma.show.getvar('SHOWFILE')) .. '" tblink_generation="' .. escape(generation) .. '" tblink_version="' .. escape(gma.show.getvar('VERSION')) .. '" ' end, 1)
      -- Metadata only: one native page export, no sequence contents or per-slot network requests.
      local index = 0
      xml = xml:gsub('<Exec%s([^>]-)>', function(attributes)
        index = index + 1
        if attributes:find('xsi:nil="true"', 1, true) then return '<Exec ' .. attributes .. '>' end
        local h = assert(obj.handle('Executor ' .. tc .. '.' .. index), 'Executor disappeared during read')
        local label = obj.label(h) or ''
        local escaped = label:gsub('&', '&amp;'):gsub('"', '&quot;'):gsub('<', '&lt;'):gsub('>', '&gt;'):gsub('\r', '&#13;'):gsub('\n', '&#10;')
        return '<Exec tblink_label="' .. escaped .. '" ' .. attributes .. '>'
      end)
      local metadata, seen = {}, {}
      for assignment in xml:gmatch('<Assignment%s[^>]*>(.-)</Assignment>') do
        local numbers = {}; for number in assignment:gmatch('<No>%s*(%d+)%s*</No>') do numbers[#numbers + 1] = tonumber(number) end
        local sequence = #numbers == 3 and numbers[1] == 25 and numbers[2] == 1 and numbers[3] or nil
        if sequence and not seen[sequence] then
          seen[sequence] = true
          local h = assert(obj.handle('Sequence ' .. sequence), 'Assigned Sequence disappeared')
          local count = assert(obj.amount(h)); assert(count <= 100000, 'Sequence metadata exceeds limit')
          local cues = {}
          for i = 0, count - 1 do
            local cue = obj.child(h, i)
            if cue and tonumber(obj.number(cue)) and tonumber(obj.number(cue)) > 0 then
              cues[#cues + 1] = '<tblink_cue index="' .. i .. '" number="' .. escape(obj.number(cue)) .. '" name="' .. escape(obj.label(cue) or '') .. '"/>'
            end
          end
          local color = sequence_appearance(sequence, h)
          metadata[#metadata + 1] = '<tblink_sequence number="' .. sequence .. '" name="' .. escape(obj.label(h) or '') .. '"' .. (color and ' color="#' .. color .. '"' or '') .. '>' .. table.concat(cues) .. '</tblink_sequence>'
        end
      end
      return xml:gsub('</MA>%s*$', function() return '<tblink_sequences>' .. table.concat(metadata) .. '</tblink_sequences></MA>' end)
    end
    if op == 'LABEL' then
      local kind, cue, show_hex, session_hex, old_hex, name_hex = body:match('^(%a+)\n([%d%.]+)\n([a-f0-9]+)\n([a-f0-9]+)\n([a-f0-9]*)\n([a-f0-9]+)$')
      assert(kind == 'single' or kind == 'sequence', 'Invalid label target')
      assert(cue:match('^%d+$') or cue:match('^%d+%.%d%d?%d?$'), 'Invalid Cue number')
      local function decode(value)
        assert(#value % 2 == 0, 'Invalid label encoding')
        return value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
      end
      local show, session, previous, name = decode(show_hex), decode(session_hex), decode(old_hex), decode(name_hex)
      assert(show == gma.show.getvar('SHOWFILE') and session == generation, 'Show or session changed; name not written')
      assert(#name > 0 and #name <= 2048 and not name:find('[%z\1-\31\127"\\]'), 'Unsupported characters in label')
      local obj = gma.show.getobj
      local address = 'Sequence ' .. tc .. (kind == 'single' and (' Cue ' .. cue) or '')
      local handle = assert(obj.handle(address), 'Rename target missing')
      local function label()
        local current = obj.handle(address)
        assert(current, 'Rename target disappeared')
        return obj.label(current) or ''
      end
      assert(label() == previous or label() == name, 'Console name changed; read console before retrying')
      local backup = 'tblink_label_' .. id
      gma.cmd('Export Sequence ' .. tc .. ' "' .. backup .. '" /o')
      assert(read(root .. '/importexport/' .. backup .. '.xml'), 'Name backup unavailable')
      assert(obj.handle(address) == handle and (label() == previous or label() == name), 'Rename target changed during backup')
      assert(show == gma.show.getvar('SHOWFILE') and session == generation, 'Show changed during backup')
      if label() ~= name then gma.cmd('Label ' .. address .. ' "' .. name .. '"') end
      assert(label() == name, 'Name readback differs; write unconfirmed')
      local function quote(value)
        return '"' .. value:gsub('[%z\1-\31\\"]', function(char) return string.format('\\u%04x', string.byte(char)) end) .. '"'
      end
      return '{"sequence":' .. tc .. ',"kind":' .. quote(kind) .. ',"cue":' .. quote(cue) .. ',"show":' .. quote(show) .. ',"generation":' .. quote(session) .. ',"name":' .. quote(label()) .. ',"backupFile":' .. quote(backup .. '.xml') .. '}'
    end
    if op == 'ASSIGNSEQ' then
      local owner, show_hex, session_hex = body:match('^([a-f0-9]+)\n([a-f0-9]+)\n([a-f0-9]+)$')
      assert(owner and #owner == 24 and #show_hex % 2 == 0 and #session_hex % 2 == 0, 'Invalid automatic assignment')
      local function decode(value) return value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end) end
      assert(decode(show_hex) == gma.show.getvar('SHOWFILE') and decode(session_hex) == generation, 'Show or session changed')
      local obj = gma.show.getobj
      assert(obj.handle('Sequence ' .. tc), 'Sequence missing')
      local label = 'TBLINK_' .. owner
      local free_page, free_exec, free_address
      local function assigned(address)
        local name = 'tblink_assignment_' .. id
        gma.cmd('Export Executor ' .. address .. ' "' .. name .. '" /o')
        local xml = assert(read(root .. '/importexport/' .. name .. '.xml'), 'Executor export unavailable')
        discard(name)
        local assignment = xml:match('<Assignment%s[^>]*>(.-)</Assignment>')
        if not assignment then return nil end
        local values = {}; for number in assignment:gmatch('<No>%s*(%d+)%s*</No>') do values[#values + 1] = tonumber(number) end
        return #values == 3 and values[1] == 25 and values[2] == 1 and values[3] or nil
      end
      -- A dedicated page avoids touching operators' physical faders and occupied slots.
      for page = 999, 900, -1 do
        local handle = obj.handle('Page ' .. page)
        if not handle then free_page = free_page or page
        elseif obj.label(handle) == label then
          for number = 101, 120 do
            local address = page .. '.' .. number
            if not obj.handle('Executor ' .. address) then
              if not free_address then free_address = address; free_exec = page end
            elseif assigned(address) == tc then
              return '{"sequence":' .. tc .. ',"executor":"' .. address .. '"}'
            end
          end
        end
      end
      if not free_address then
        assert(free_page, 'No empty page available for automatic sync')
        assert(not obj.handle('Page ' .. free_page), 'Page became occupied')
        gma.cmd('Store Page ' .. free_page .. ' "' .. label .. '" /nc')
        assert(obj.label(assert(obj.handle('Page ' .. free_page))) == label, 'Page creation unconfirmed')
        free_exec = free_page; free_address = free_page .. '.101'
      end
      assert(obj.label(assert(obj.handle('Page ' .. free_exec))) == label, 'Page ownership changed')
      assert(not obj.handle('Executor ' .. free_address), 'Executor became occupied')
      gma.cmd('Assign Sequence ' .. tc .. ' At Executor ' .. free_address .. ' /nc')
      assert(obj.handle('Executor ' .. free_address) and assigned(free_address) == tc, 'Sequence assignment unconfirmed')
      return '{"sequence":' .. tc .. ',"executor":"' .. free_address .. '"}'
    end
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
      assert(body == '' or body == 'keep', 'Sequence request must be empty or keep')
      assert(gma.show.getobj.handle('Sequence ' .. tc), 'Sequence missing')
      local name = 'tblink_library_' .. id
      gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '" /o')
      local xml = assert(read(root .. '/importexport/' .. name .. '.xml'), 'Sequence export unavailable')
      gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '_verify" /o')
      assert(canonical(xml) == canonical(assert(read(root .. '/importexport/' .. name .. '_verify.xml'))), 'Sequence changed during read')
      discard(name .. '_verify')
      if body ~= 'keep' then discard(name) end
      return xml
    end
    if op == 'SEQCUES' then
      -- The complete export stays on the console; only the requested Cue elements cross the network.
      assert(#body > 0 and #body <= 65536 and not body:find('[^%d%.,]'), 'Invalid Cue list')
      assert(gma.show.getobj.handle('Sequence ' .. tc), 'Sequence missing')
      local wanted = {}
      for value in body:gmatch('[^,]+') do
        local whole, fraction = value:match('^(%d+)%.(%d%d%d)$')
        assert(whole, 'Invalid Cue number')
        wanted[tonumber(whole) * 1000 + tonumber(fraction)] = true
      end
      local name = 'tblink_library_' .. id
      gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '" /o')
      local xml = assert(read(root .. '/importexport/' .. name .. '.xml'), 'Sequence export unavailable')
      gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '_verify" /o')
      assert(canonical(xml) == canonical(assert(read(root .. '/importexport/' .. name .. '_verify.xml'))), 'Sequence changed during read')
      discard(name .. '_verify')
      local head = assert(xml:match('^(.-<Sequ%s[^>]*>)'), 'Sequence XML unavailable')
      assert(head:sub(-2) ~= '/>', 'Sequence has no Cues')
      local parts, position = { head }, 1
      while true do
        local first, last, attributes = xml:find('<Cue%s([^>]*)>', position)
        if not first then break end
        position = last + 1
        if attributes:sub(-1) ~= '/' then
          local _, close = xml:find('</Cue>', position, true)
          assert(close, 'Sequence XML unavailable')
          local cue = xml:sub(first, close)
          local tag = cue:match('<Number%s[^>]*>') or ''
          local whole = tonumber(tag:match('%snumber="(%d+)"'))
          local fraction = tonumber(tag:match('sub_number="(%d+)"') or '0')
          if whole and fraction and wanted[whole * 1000 + fraction] then parts[#parts + 1] = cue end
          position = close + 1
        end
      end
      parts[#parts + 1] = '</Sequ></MA>'
      discard(name)
      return table.concat(parts, '\n')
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
      discard(name); discard(name .. '_verify')
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
      discard(name)
      return export_scratch(tc, 'tblink_created_' .. id)
    end
    assert(gma.show.getobj.handle('Timecode ' .. tc), 'Timecode does not exist')
    if op == 'READ' then return export_scratch(tc, 'tblink_read_' .. id) end
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
    local verified = export_scratch(tc, 'tblink_verify_' .. id)
    discard(name)
    return verified
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
local snapshot_cache = nil
local function hex(data) return (data:gsub('.', function(c) return string.format('%02x', string.byte(c)) end)) end
_G.TBLINK_NET = function(token, action, id, a, b, c)
  if not token:match('^[a-f0-9]+$') or #token ~= 32 then return end
  local ok, result = pcall(function()
    assert(active and _G.TBLINK_BRIDGE_GENERATION == generation, 'Bridge is stopped')
    assert(type(id) == 'string' and #id == 32 and id:match('^[a-f0-9]+$'), 'Invalid request identity')
    if action == 'begin' or action == 'beginsync' then
      assert(id ~= last, 'Request already processed')
      local base = nil
      if action == 'beginsync' then
        assert(snapshot_cache and snapshot_cache.id == a and snapshot_cache.target == b, 'Snapshot reference expired or mismatched')
        base = snapshot_cache.xml
        a = 'SYNC'
      end
      assert(a == 'PING' or a == 'PAGES' or a == 'PAGE' or a == 'LIST' or a == 'LISTSEQ' or a == 'SEQUENCE' or a == 'SEQCUES' or a == 'READ' or a == 'SNAPSHOT' or a == 'SCOPE' or a == 'APPLY' or a == 'SYNC' or a == 'CREATE' or a == 'EXECUTOR' or a == 'ASSIGNSEQ' or a == 'LABEL', 'Invalid operation')
      assert(type(b) == 'number' and b >= 1 and b <= 99999 and b == math.floor(b), 'Invalid target')
      assert(type(c) == 'number' and c >= 0 and c <= 33554432 and c == math.floor(c), 'Invalid payload size')
      assert(not network or gma.gettime() > network.expires, 'Another network request is pending')
      network = { id = id, op = a, target = b, size = c, bytes = 0, chunks = {}, base = base, expires = gma.gettime() + 120 }
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
      if network.base then body = #network.base .. '\n' .. network.base .. body; network.base = nil end
      network.response = process(id .. '\n' .. network.op .. '\n' .. network.target .. '\n' .. #body .. '\n' .. body)
      assert(#network.response <= 33554500, 'Response exceeds limit')
      if network.op == 'SNAPSHOT' or network.op == 'SCOPE' then
        local content = network.response:match('^[a-f0-9]+\nOK\n%d+\n(.*)$')
        snapshot_cache = content and { id = id, target = network.target, xml = content } or nil
        if content then
          -- Fixture values are never edited by this application. Keep the complete
          -- export here for SYNC's exact preflight, but send only Cue metadata.
          -- Cue/CuePart attributes and Number remain unchanged for reference checks.
          local compact = content:gsub('<CueDatas%s*>.-</CueDatas>', '')
          network.response = id .. '\nOK\n' .. #compact .. '\n' .. compact
        end
      end
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
-- Executor keys use the existing authenticated Telnet channel. A lease prevents
-- Flash/Temp/Swop sticking on after a renderer crash or a broken network cable.
local executor_keys = {}
local executor_functions = {
  [12299]={'Go',false},[12297]={'GoBack',false},[12298]={'Pause',false},[12290]={'Off',false},
  [12293]={'On',false},[12307]={'Toggle',false},[12302]={'Flash',true},[12291]={'Temp',true},
  [12306]={'Swop',true},[12322]={'SwopOn',true},[12323]={'SwopGo',true},[12320]={'FlashOn',true},
  [12321]={'FlashGo',true},[12303]={'Black',true},[12292]={'Top',false},[12301]={'Load',false},
  [12325]={'LoadNext',false},[12305]={'Select',false},[12295]={'Learn',false},[12308]={'Rate1',false},
  [12318]={'ToFull',false},[12319]={'ToZero',false}
}
local function release_executor_key(key)
  if key.momentary and gma.show.getvar('SHOWFILE') == key.show and gma.show.getobj.handle(key.address) == key.handle then
    gma.cmd(key.name .. ' Off ' .. key.address)
  end
end
local function expire_executor_keys()
  for id,key in pairs(executor_keys) do
    if not key.expired and (not active or _G.TBLINK_BRIDGE_GENERATION ~= generation or gma.gettime() > key.expires) then
      release_executor_key(key); key.expired=true
    end
    if gma.gettime()>key.expires+600 then executor_keys[id]=nil end
  end
end
_G.TBLINK_EXEC_RELEASE_ALL = function()
  for id,key in pairs(executor_keys) do release_executor_key(key); executor_keys[id]=nil end
end
_G.TBLINK_EXEC_INPUT = function(token,id,page,slot,button,pressed,code,sequence,label_hex,show_hex,generation_hex,reference_hex)
  if type(token) ~= 'string' or #token ~= 32 or not token:match('^[a-f0-9]+$') then return end
  local ok,result = pcall(function()
    local function unhex(value)
      assert(type(value)=='string' and #value<=4096 and #value%2==0 and not value:find('[^a-f0-9]'),'Invalid encoded text')
      return (value:gsub('..',function(pair)return string.char(tonumber(pair,16))end))
    end
    assert(type(id)=='string' and #id==32 and id:match('^[a-f0-9]+$'),'Invalid press identity')
    local key = executor_keys[id]
    if not pressed then
      if key then release_executor_key(key);key.expired=true;key.expires=gma.gettime()
      else executor_keys[id]={expired=true,expires=gma.gettime()} end
      return 'RELEASED'
    end
    assert(active and _G.TBLINK_BRIDGE_GENERATION==generation and unhex(generation_hex)==generation,'Bridge session changed')
    assert(unhex(show_hex)==gma.show.getvar('SHOWFILE'),'Show changed')
    assert(type(page)=='number' and page>=1 and page<=9999 and page==math.floor(page),'Invalid page')
    assert(type(slot)=='number' and slot>=1 and slot<=240 and slot==math.floor(slot),'Invalid executor')
    assert(type(button)=='number' and button>=0 and button<=2 and button==math.floor(button),'Invalid button')
    local address='Executor '..page..'.'..slot
    if key then
      assert(not key.expired,'Press expired; press again')
      assert(key.address==address and key.code==code and key.button==button,'Press identity changed')
      assert(gma.show.getobj.handle(address)==key.handle,'Executor moved while pressed')
      key.expires=gma.gettime()+2; return 'HELD'
    end
    local fn=assert(executor_functions[code],'Unsupported executor function')
    local obj=gma.show.getobj
    local handle=assert(obj.handle(address),'Executor missing')
    assert((obj.label(handle) or '')==unhex(label_hex),'Executor name changed')
    local file='tblink_exec_key_'..token
    gma.cmd('Export '..address..' '..file..' /o')
    local xml=assert(read(root..'/importexport/'..file..'.xml'),'Executor export unavailable')
    discard(file)
    local assignment=xml:match('<Assignment%s[^>]*>(.-)</Assignment>')
    local numbers={};for number in (assignment or ''):gmatch('<No>%s*(%d+)%s*</No>')do numbers[#numbers+1]=tonumber(number)end
    assert(table.concat(numbers,'.')==unhex(reference_hex),'Executor assignment changed')
    if sequence>0 then
      assert(#numbers==3 and numbers[1]==25 and numbers[2]==1 and numbers[3]==sequence,'Executor assignment changed')
    end
    local buttons={};for value in xml:gmatch('<Button>%s*(%d+)%s*</Button>')do buttons[#buttons+1]=tonumber(value)end
    assert(buttons[button+1]==code,'Executor function changed')
    gma.cmd(fn[1]..(fn[2] and ' On ' or ' ')..address)
    executor_keys[id]={address=address,handle=handle,name=fn[1],code=code,button=button,momentary=fn[2],show=gma.show.getvar('SHOWFILE'),expires=gma.gettime()+2}
    return 'SENT'
  end)
  local response=ok and result or 'ERR:'..hex(tostring(result))
  gma.echo('TBLINK_EXEC_'..token..':'..response)
  return response
end
local function main(mode)
  if active then active = false; _G.TBLINK_BRIDGE_READY = false; gma.feedback('TBLINK bridge stopped'); return end
  if mode == 'network' then
    active = true
    _G.TBLINK_BRIDGE_READY = true
    gma.timer(expire_executor_keys, 0.25, 0)
    return
  end
  -- A restart must not replay a previously sent write with an uncertain outcome.
  os.rename(request_file, root .. '/temp/tblink_bridge_abandoned_' .. generation .. '.txt')
  active = true
  _G.TBLINK_BRIDGE_READY = true
  gma.timer(expire_executor_keys, 0.25, 0)
  gma.timer(poll, 0.1, 0)
  gma.feedback('TBLINK local onPC bridge ready')
end
return main
