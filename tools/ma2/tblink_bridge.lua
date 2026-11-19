-- Local onPC bridge. Start once from a plugin; stop by running this plugin again.
-- Requests are data, never executable Lua. Only one explicitly addressed Timecode is touched.
local active = false
-- Remove every export a request makes only to read or compare once it is done. Kept: write
-- backups (tblink_backup_, tblink_label_) and a SEQUENCE export requested with body 'keep';
-- the program rotates those out later with DISCARD.
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
local function bounded_read(path, limit)
  local file = io.open(path, 'rb')
  if not file then return nil end
  local data = file:read(limit + 1) or ''
  file:close()
  if #data > limit then return nil, true end
  return data
end
local function read(path)
  local data, larger = bounded_read(path, 33554432)
  assert(not larger, 'Bridge file exceeds limit')
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
-- Sequence fixture data can be hundreds of MB. Scan bounded XML tokens on the console,
-- never load/transfer a complete Sequence merely to prepare its Cue triggers.
local function sequence_stream(path, strip_triggers, visit, work, preserve_spacing)
  local file = assert(io.open(path, 'rb'), 'Sequence export unavailable')
  if work then work.files[file] = true end
  local buffer, cursor, ended, stack = '', 1, false, {}
  local function token()
    while true do
      if cursor <= #buffer then
        local finish
        local opaque = stack[#stack] == 'CueDatas'
        local closing = '</CueDatas>'
        if opaque and buffer:sub(cursor, cursor + #closing - 1) ~= closing then
          -- Fixture payload is opaque: retain and compare every byte, but never
          -- run Lua for its millions of Channel/Value tags. Keep a delimiter tail
          -- when the closing tag straddles two reads.
          local ending = buffer:find(closing, cursor, true)
          finish = ending and ending - 1 or #buffer - #closing + 1
          if finish >= cursor then
            local value = buffer:sub(cursor, finish); cursor = finish + 1; return value, true
          end
          finish = nil
        elseif buffer:sub(cursor, cursor) == '<' then
          finish = buffer:find('>', cursor + 1, true)
          assert(finish or #buffer - cursor < 65536, 'Sequence XML tag too large')
        else finish = (buffer:find('<', cursor, true) or (#buffer + 1)) - 1 end
        if finish then local value = buffer:sub(cursor, finish); cursor = finish + 1; return value end
      end
      if ended then assert(cursor > #buffer, 'Incomplete Sequence XML'); return nil end
      -- MA throttles interpreted Lua instructions. Large native reads keep the
      -- opaque payload work proportional to MiB blocks, not fixture nodes.
      local part = file:read(stack[#stack] == 'CueDatas' and 1048576 or 32768)
      if part and work then work.checkpoint(#part, 0) end
      if part then buffer = buffer:sub(cursor) .. part; cursor = 1 else ended = true end
    end
  end
  local function next_part()
    while true do
      if work then work.checkpoint(0, 1) end
      local value, opaque = token()
      if not value then assert(#stack == 0, 'Incomplete Sequence XML'); return nil end
      if opaque then return value, true end
      local parent = stack[#stack]
      if value:sub(1, 1) == '<' then
        local closing, name = value:match('^<(/?)([%w_:%-]+)')
        if name then
          local empty = value:match('/%s*>$') ~= nil
          if visit then visit(value, name, closing == '/', parent, empty) end
          if closing == '/' then assert(parent == name, 'Invalid Sequence XML nesting'); stack[#stack] = nil
          elseif not empty then stack[#stack + 1] = name end
          -- Only the export stamp and direct Cue Trigger are excluded; all fixture,
          -- fade, delay, command and sequence bytes are compared unchanged.
          local stamp = name == 'Info' and parent == 'MA'
          local trigger = name == 'Trigger' and parent == 'Cue'
          assert(not (stamp or trigger) or empty, 'Unsupported Sequence metadata element')
          if not stamp and not (strip_triggers and trigger) then return value end
        else return value end
      elseif preserve_spacing or not (value:match('^%s*$') and (parent == 'MA' or parent == 'Sequ' or parent == 'Cue')) then return value end
    end
  end
  return next_part, function() file:close(); if work then work.files[file] = nil end end
end
-- Keep sequence metadata, but retain fixture payload only for the requested Cue numbers.
-- Native backup files and the full-file comparison always include every fixture byte.
local function cue_selection(path, wanted, project_large)
  if not project_large then
    local small, larger = bounded_read(path, 262144)
    if not larger then return assert(small, 'Sequence export unavailable') end
  end
  local selected, number_seen = false, false
  local part, close = sequence_stream(path, false, function(value, name, closing, parent)
    if not closing and name == 'Cue' and parent == 'Sequ' then selected, number_seen = false, false end
    if not closing and name == 'Number' and parent == 'Cue' then
      local whole = tonumber(value:match('%snumber="(%d+)"'))
      local sub = tonumber(value:match('%ssub_number="(%d+)"') or '0')
      assert(whole and sub, 'Invalid Sequence Cue number')
      number_seen = true
      selected = wanted[whole * 1000 + sub]
    elseif not closing and name == 'CueDatas' then
      assert(number_seen, 'Cue number missing before fixture data')
    end
  end, nil, true)
  local ok, xml = pcall(function()
    local parts = {}
    while true do
      local value, fixture = part()
      if not value then break end
      if not fixture or selected then parts[#parts + 1] = value end
    end
    return table.concat(parts)
  end)
  close()
  assert(ok, xml)
  return xml
end
local function sequence_triggers(path, target, work)
  local cues, number, changed, count, sequences = {}, nil, false, 0, 0
  local next_part, close = sequence_stream(path, false, function(value, name, closing, parent, empty)
    if name == 'Sequ' and parent == 'MA' and not closing then
      sequences = sequences + 1
      assert(tonumber(value:match('%sindex="(%d+)"')) == target - 1, 'Sequence export number mismatch')
    end
    if name == 'Cue' and parent == 'Sequ' and not closing and not empty then number = nil; changed = false end
    if name == 'Number' and parent == 'Cue' and not closing then
      local whole = tonumber(value:match('%snumber="(%d+)"'))
      local fraction = tonumber(value:match('%ssub_number="(%d+)"') or '0')
      assert(whole and whole <= 999999 and fraction <= 999, 'Invalid Sequence Cue number')
      number = string.format('%d.%03d', whole, fraction)
    end
    if name == 'Trigger' and parent == 'Cue' and not closing then
      local kind = assert(value:match('%stype="([^"]*)"'), 'Cue Trigger type unavailable')
      if kind ~= 'Go' then changed = true end
    end
    if name == 'Cue' and closing then
      count = count + 1; assert(count <= 100000, 'Sequence Cue count exceeds limit')
      if changed then assert(number, 'Cue number unavailable'); cues[#cues + 1] = number end
    end
  end, work)
  local ok, err = pcall(function() while next_part() do end; assert(sequences == 1, 'Sequence export missing or ambiguous') end); close(); assert(ok, err)
  return cues
end
local function same_sequence_files(left, right, strip_triggers, work)
  -- The common case is two native exports with equal-length timestamp fields. Compare native
  -- blocks directly rather than tokenizing the same fixture data twice. For any difference
  -- the canonical reader below still decides whether the change is meaningful.
  if not strip_triggers and not work then
    local a = assert(io.open(left, 'rb'), 'Sequence export unavailable')
    local b = io.open(right, 'rb')
    if not b then a:close(); error('Sequence verification export unavailable') end
    local ok, equal = pcall(function()
      local x, y = a:read(32768), b:read(32768)
      if not x or not y or canonical(x) ~= canonical(y) then return false end
      repeat
        x, y = a:read(1048576), b:read(1048576)
        if x ~= y then return false end
      until not x
      return true
    end)
    a:close(); b:close(); assert(ok, equal)
    if equal then return true end
  end
  local a, close_a = sequence_stream(left, strip_triggers, nil, work)
  local ok_open, b, close_b = pcall(sequence_stream, right, strip_triggers, nil, work)
  if not ok_open then close_a(); error(b) end
  local ok, equal = pcall(function()
    local x, y, i, j = a(), b(), 1, 1
    while x and y do
      local n = math.min(#x - i + 1, #y - j + 1)
      if x:sub(i, i + n - 1) ~= y:sub(j, j + n - 1) then return false end
      i = i + n; j = j + n
      if i > #x then x = a(); i = 1 end
      if j > #y then y = b(); j = 1 end
    end
    return x == nil and y == nil
  end)
  close_a(); close_b(); assert(ok, equal); return equal
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
-- A request is a table of steps. One step does at most one Export or Import on the console, so the
-- program can send other commands (lights off, a Cue) between two steps. Writing is one step as a
-- whole: backup export, compare, write the file, Import. Steps run one per 'step' call, or all at
-- once for the local file bridge and for a 'run' without 'steps'. The state lives on the request.
local snapshot_files = {}
local function snapshot(step, tc, id, additional, done, previous)
  local xml = export_scratch(tc, 'tblink_snapshot_' .. id)
  local numbers, seen = references(xml), {}
  for _, number in ipairs(numbers) do seen[number] = true end
  for _, number in ipairs(additional or {}) do
    assert(number >= 1 and number <= 99999 and number == math.floor(number), 'Invalid additional Sequence')
    if not seen[number] then seen[number] = true; numbers[#numbers + 1] = number end
  end
  table.sort(numbers)
  local parts = {}
  local inline_bytes = 0
  local known = {}
  if previous then
    for object in previous:gmatch('(<Sequ%s.-</Sequ>)') do
      local index = tonumber(object:match('^<Sequ%s[^>]-index="(%d+)"'))
      if index then known[index + 1] = object end
    end
  end
  local function finish()
    assert(canonical(xml) == canonical(export(tc, 'tblink_snapshot_verify_' .. id)), 'Timecode changed during snapshot')
    discard('tblink_snapshot_verify_' .. id)
    local result, replaced = xml:gsub('</MA>%s*$', function() return table.concat(parts, '\n') .. '\n</MA>' end)
    assert(replaced == 1 and #result <= 33554432, 'Snapshot XML invalid or too large')
    done(result)
  end
  local function next_sequence(i)
    local number = numbers[i]
    if not number then return step(finish) end
    local name = 'tblink_sequence_' .. id .. '_' .. number
    step(function()
      assert(gma.show.getobj.handle('Sequence ' .. number), 'Referenced Sequence is missing')
      gma.cmd('Export Sequence ' .. number .. ' "' .. name .. '" /o')
      local dir = root .. '/importexport/'
      local path = dir .. name .. '.xml'
      local full, large = bounded_read(path, math.min(262144, 1048576 - inline_bytes))
      if large then
        -- The editor needs the step table. SYNC still compares the complete native file,
        -- including every unrelated fixture, before accepting this revision.
        local show = gma.show.getvar('SHOWFILE')
        local prior = snapshot_files[number]
        local function add(ref)
          parts[#parts + 1] = ref.object
          next_sequence(i + 1)
        end
        if prior and prior.show == show and same_sequence_files(path, dir .. prior.name .. '.xml', false) then
          discard(name); return add(prior)
        end
        local projected = cue_selection(path, {}, true)
        local object = assert(projected:match('(<Sequ%s.-</Sequ>)'), 'Sequence XML unavailable')
        object = object:gsub('</Sequ>$', '<!--tblink-native-' .. id .. '--></Sequ>')
        return step(function()
          gma.cmd('Export Sequence ' .. number .. ' "' .. name .. '_verify" /o')
          local same = same_sequence_files(path, dir .. name .. '_verify.xml', false)
          discard(name .. '_verify')
          if not same then discard(name); error('Sequence changed during snapshot') end
          local updated = {show=show, name=name, object=object}
          local old = snapshot_files[number]
          snapshot_files[number] = updated
          if old then discard(old.name) end
          add(updated)
        end)
      end
      assert(full, 'Sequence export unavailable')
      inline_bytes = inline_bytes + #full
      local object = assert(full:match('(<Sequ%s.-</Sequ>)'), 'Sequence XML unavailable')
      parts[#parts + 1] = object
      -- Every Sequence is freshly exported. An exact match with its previously verified native
      -- object is already the second identical observation, even when fixture values are present.
      if known[number] == object then
        discard(name)
        return next_sequence(i + 1)
      end
      step(function()
        gma.cmd('Export Sequence ' .. number .. ' "' .. name .. '_verify" /o')
        local check = assert(read(root .. '/importexport/' .. name .. '_verify.xml'))
        assert(canonical(full) == canonical(check), 'Sequence changed during snapshot')
        discard(name); discard(name .. '_verify')
        next_sequence(i + 1)
      end)
    end)
  end
  next_sequence(1)
end
-- Index once per native export, including the largest Sequence used by a batch.
-- Ask MA2 itself for the state at each source Cue. Status includes inherited values, effects,
-- releases and cue parts. The temporary sequence is never assigned to an executor or played.
local function tracked_cues(seq, wanted, source_xml, name)
  local obj = gma.show.getobj
  local show = gma.show.getvar('SHOWFILE')
  local function current() return show == gma.show.getvar('SHOWFILE') and _G.TBLINK_BRIDGE_GENERATION == generation end
  local header = assert(source_xml:match('(<MA%s[^>]+>)'), 'Sequence header unavailable')
  local slots = {}
  for n in pairs(wanted) do slots[#slots+1] = n end
  table.sort(slots)
  local scratch = 9989
  while scratch > 0 and obj.handle('Sequence ' .. scratch) do scratch = scratch-1 end
  assert(scratch > 0, '控台没有空闲序列，无法读取素材继承的灯光')
  local address = 'Sequence ' .. scratch
  local dir = root .. '/importexport/'
  local seed = header .. '<Sequ index="' .. (scratch-1) .. '" name="' .. name .. '"><Cue xsi:nil="true"/>'
  -- Seed the destination before Copy into the first Cue (onPC 3.7 needs an existing slot).
  local seed_number = 1000
  while wanted[seed_number] do seed_number = seed_number+1 end
  seed = seed .. '<Cue index="1"><Number number="' .. math.floor(seed_number/1000) .. '" sub_number="' .. seed_number%1000 .. '"/><CuePart index="0"/></Cue></Sequ></MA>'
  local owned
  local ok, result = pcall(function()
    write(dir .. name .. '.xml', seed)
    assert(current() and not obj.handle(address), 'Temporary sequence changed')
    gma.cmd('Import ' .. name .. '.xml At ' .. address .. ' /nc')
    owned = assert(obj.handle(address), 'Temporary sequence unavailable')
    assert(obj.label(owned) == name, 'Temporary sequence changed')
    for _, n in ipairs(slots) do
      local cue = string.format('%d.%03d', math.floor(n/1000), n%1000)
      assert(current() and obj.handle(address) == owned and obj.handle('Sequence ' .. seq .. ' Cue ' .. cue), 'Source Cue missing')
      gma.cmd('Copy Sequence ' .. seq .. ' Cue ' .. cue .. ' At ' .. address .. ' Cue ' .. cue .. ' /status=true /o /nc')
      assert(obj.handle(address .. ' Cue ' .. cue), 'Copied Cue missing')
    end
    assert(current() and obj.handle(address) == owned, 'Temporary sequence changed')
    gma.cmd('Export ' .. address .. ' ' .. name .. '_result /o')
    local xml = cue_selection(dir .. name .. '_result.xml', wanted)
    local source_tag = assert(source_xml:match('(<Sequ%s[^>]+>)'))
    xml = xml:gsub('<Cue%s+index="[^"]+"[^>]*>.-</Cue>', function(cue)
      local n, sub = cue:match('<Number%s+number="(%d+)"%s+sub_number="(%d+)"')
      return n and wanted[tonumber(n)*1000+tonumber(sub)] and cue or ''
    end)
    return (xml:gsub('<Sequ%s[^>]+>', function() return source_tag end, 1))
  end)
  if current() and owned and obj.handle(address) == owned and obj.label(owned) == name then
    gma.cmd('Delete ' .. address .. ' /nc')
    assert(not obj.handle(address), 'Temporary sequence still present')
  end
  discard(name); discard(name .. '_result')
  assert(ok, result)
  return result
end

-- Restore the complete source before asking MA2 for a tracked look. A single archived Cue
-- omits values inherited from the preceding steps. Both temporary sequences stay unassigned.
local function archived_tracked_cues(target, wanted, token, id)
  local dir = root .. '/importexport/'
  local file = 'tblink_archive_' .. token
  local path = dir .. file .. '.xml'
  local xml = cue_selection(path, {})
  local name = 'tblink_arch_' .. id
  local obj = gma.show.getobj
  local show = gma.show.getvar('SHOWFILE')
  local function current() return show == gma.show.getvar('SHOWFILE') and generation == _G.TBLINK_BRIDGE_GENERATION end
  local scratch = 9989
  while scratch > 0 and (scratch == target or obj.handle('Sequence ' .. scratch)) do scratch = scratch-1 end
  assert(scratch > 0, '控台没有空闲序列，无法恢复素材继承的灯光')
  local address = 'Sequence ' .. scratch
  local owned
  local ok, result = pcall(function()
    local out = assert(io.open(dir .. name .. '.xml', 'wb'))
    local part, close = sequence_stream(path, false, nil, nil, true)
    local copied, why = pcall(function()
      local count = 0
      while true do
        local value, opaque = part()
        if not value then break end
        if not opaque and value:match('^<Sequ%s') then
          assert(tonumber(value:match('%sindex="(%d+)"')) == target-1, 'Saved sequence identity changed')
          value = value:gsub('%sname="[^"]*"', '', 1):gsub('^<Sequ%s', '<Sequ name="' .. name .. '" ', 1)
          count = count + 1
        end
        assert(out:write(value))
      end
      assert(count == 1, 'Saved sequence unavailable')
    end)
    close(); assert(out:close()); assert(copied, why)
    assert(current() and not obj.handle(address), 'Temporary sequence changed')
    gma.cmd('Import ' .. name .. '.xml At ' .. address .. ' /nc')
    owned = assert(obj.handle(address), 'Temporary sequence unavailable')
    assert(obj.label(owned) == name and current(), 'Temporary sequence changed')
    return tracked_cues(scratch, wanted, xml, 'tblink_status_' .. id)
  end)
  if current() and owned and obj.handle(address) == owned and obj.label(owned) == name then
    gma.cmd('Delete ' .. address .. ' /nc')
    assert(not obj.handle(address), 'Temporary sequence still present')
  end
  discard(file); discard(name)
  assert(ok, result)
  return result
end

-- Select a native CueData row as a unit: every fixture, part, timing and effect layer of
-- a selected attribute travels together. The console never receives a Programmer or Filter change.
local function attr_hex(s) return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end)) end
local function attr_name(raw)
  return (raw:gsub('&#x(%x+);', function(v) return utf8.char(tonumber(v,16)) end):gsub('&#(%d+);', function(v) return utf8.char(tonumber(v)) end)
    :gsub('&quot;', '"'):gsub('&apos;', "'"):gsub('&lt;', '<'):gsub('&gt;', '>'):gsub('&amp;', '&'))
end
local function material_cue(xml, wanted, mask)
  local head = assert(xml:match('(<MA%s[^>]+>)'), 'Native header missing')
  local seq = assert(xml:match('(<Sequ%s[^>]+>)'), 'Native sequence missing')
  local selected, found = {}, {}
  for key in (mask or ''):gmatch('[^+]+') do selected[key] = true end
  for cue in xml:gmatch('<Cue%s+index="[^"]+"[^>]*>.-</Cue>') do
    local n, sub = cue:match('<Number%s+number="(%d+)"%s+sub_number="(%d+)"')
    if n and tonumber(n)*1000+tonumber(sub) == wanted then
      local rows = {}
      for row in cue:gmatch('<CueData[%s>].-</CueData>') do
        local channel = assert(row:match('<Channel%s[^>]*>'), 'CueData channel missing')
        local attr = channel:match('%sattribute_name="([^"]+)"')
        assert(attr, '控台有一项灯具属性没有名称，请直接添加全部属性')
        local key = attr_hex(attr_name(attr))
        found[key] = true
        if selected[key] then rows[#rows+1] = row end
      end
      for key in pairs(selected) do assert(found[key], '所选灯具属性已在控台改变，请重新打开这个 Cue 选择属性') end
      local names = {}
      for key in pairs(found) do names[#names+1] = key end
      table.sort(names)
      if not mask then return nil, table.concat(names, ',') end
      -- A fixture attribute selection must not also copy a source Cue's macro or follow trigger.
      -- Preserve native parameter layers and their timing within each Part.
      local parts, cursor = {}, 1
      while true do
        local first, last, opening = cue:find('(<CuePart%s[^>]*>)', cursor)
        if not first then break end
        local timing = ''
        if opening:sub(-2) ~= '/>' then
          local close, finish = cue:find('</CuePart>', last+1, true)
          assert(close, 'Incomplete Cue Part')
          timing = cue:sub(last+1, close-1):match('(<CuePartPresetTiming>.-</CuePartPresetTiming>)') or ''
          last = finish
        end
        local keep = {'index="' .. assert(opening:match('%sindex="(%d+)"'), 'Cue Part number missing') .. '"'}
        for field, value in opening:gmatch('%s([%w_]+)="([^"]*)"') do
          if field:find('fade') or field:find('delay') then keep[#keep+1] = field .. '="' .. value .. '"' end
        end
        parts[#parts+1] = '<CuePart ' .. table.concat(keep, ' ') .. '>' .. timing .. '</CuePart>'
        cursor = last+1
      end
      local number = assert(cue:match('<Number%s[^>]*/>'), 'Cue number missing')
      return head .. seq .. '<Cue xsi:nil="true"/><Cue index="1">' .. number .. '<CueDatas>' ..
        table.concat(rows) .. '</CueDatas>' .. table.concat(parts) .. '</Cue></Sequ></MA>', table.concat(names, ',')
    end
  end
  error('Source Cue missing')
end

local function copy_material(xml, cue, dest, mode, name)
  local show, obj = gma.show.getvar('SHOWFILE'), gma.show.getobj
  local function current() return gma.show.getvar('SHOWFILE') == show and _G.TBLINK_BRIDGE_GENERATION == generation end
  local scratch = 9989
  while scratch > 0 and obj.handle('Sequence ' .. scratch) do scratch = scratch-1 end
  assert(scratch > 0, '控台没有空闲序列，无法复制选中的灯具属性')
  local address = 'Sequence ' .. scratch
  local tagged = xml:gsub('<Sequ%s[^>]+>', '<Sequ index="' .. (scratch-1) .. '" name="' .. name .. '">', 1)
  local owned
  local ok, why = pcall(function()
    write(root .. '/importexport/' .. name .. '.xml', tagged)
    assert(current() and not obj.handle(address), 'Temporary sequence changed')
    gma.cmd('Import ' .. name .. '.xml At ' .. address .. ' /nc')
    owned = assert(obj.handle(address), 'Temporary sequence missing')
    assert(current() and obj.label(owned) == name and obj.handle(address .. ' Cue ' .. cue), 'Temporary Cue missing')
    gma.cmd('Copy ' .. address .. ' Cue ' .. cue .. ' At ' .. dest .. ' /status=false' .. mode)
  end)
  if current() and owned and obj.handle(address) == owned and obj.label(owned) == name then
    gma.cmd('Delete ' .. address .. ' /nc')
    assert(not obj.handle(address), 'Temporary sequence still present')
  end
  discard(name)
  assert(ok, why)
end

local function first_cue_data(xml, keep_cue)
  local result = {}
  for cue in xml:gmatch('<Cue%s+index="[^"]+"[^>]*>.-</Cue>') do
    local n, sub = cue:match('<Number%s+number="(%d+)"%s+sub_number="(%d+)"')
    if n then
      local number = tonumber(n)*1000+tonumber(sub)
      result[number] = (cue:match('<CueDatas[^>]*>(.-)</CueDatas>') or ''):gsub('>%s+<','><'):match('^%s*(.-)%s*$')
      if keep_cue and keep_cue[number] then keep_cue[number] = cue:gsub('^(<Cue%s+)index="[^"]+"', '%1', 1) end
    end
  end
  return result
end
local function first_cue_layers(rows, data)
  -- MA combines value/effect layers separately. The last selected material supplies a repeated layer.
  local rest = data:gsub('<CueData[%s>].-</CueData>', '')
  assert(rest == '', 'Unsupported fixture data in combined Cue')
  for attributes, body in data:gmatch('<CueData([^>]*)>(.-)</CueData>') do
    local channel = assert(body:match('(<Channel%s[^>]-/>)'), 'Unsupported channel in combined Cue')
    local key = channel .. attributes
    local layers = rows[key] or {}
    local content = body:gsub('<Channel%s[^>]-/>', '', 1)
    local cursor = 1
    while cursor <= #content do
      local start, opening, tag = content:find('<([%w_:]+)[^>]*>', cursor)
      assert(start == cursor, 'Unsupported data in combined Cue')
      local finish = opening
      if content:sub(opening-1,opening) ~= '/>' then
        local _, closing = content:find('</' .. tag .. '>',opening+1,true)
        finish = assert(closing, 'Incomplete layer in combined Cue')
      end
      layers[tag] = content:sub(start,finish)
      cursor = finish + 1
    end
    rows[key] = layers
  end
end
local function same_first_layers(a, b)
  for key, layers in pairs(a) do
    if not b[key] then return false end
    for layer, value in pairs(layers) do if b[key][layer] ~= value then return false end end
  end
  return true
end
-- Append only to the sequence actually assigned to the desk's first Timecode track. The journal
-- binds an edit identity to a native Cue number across rapid edits, reconnects and lost replies.
local function first_track_cues(tc, id, body)
  local owner, sh, gen, addr, expected, rows = body:match('^(%x+)\n(%x+)\n(%x+)\n(%d+%.%d+)\n(%d+)\n(.+)$')
  assert(owner and #owner == 64 and #sh % 2 == 0 and #gen % 2 == 0, 'Invalid first track request')
  local function decode(s) return (s:gsub('..', function(p) return string.char(tonumber(p, 16)) end)) end
  local function guard() assert(gma.show.getvar('SHOWFILE') == decode(sh) and _G.TBLINK_BRIDGE_GENERATION == decode(gen), 'Show or session changed') end
  guard()
  local dir = root .. '/importexport/'
  local obj = gma.show.getobj
  local temp = 'tblink_first_' .. id
  local function export(address, name, keep, wanted)
    gma.cmd('Export ' .. address .. ' ' .. name .. ' /o')
    local path = dir .. name .. '.xml'
    local xml = wanted and cue_selection(path, wanted) or assert(read(path), 'Object export unavailable')
    if not keep then discard(name) end
    return xml
  end
  local timeline = export('Timecode ' .. tc, temp .. '_tc')
  local first, opening = timeline:find('<Track%s[^>]*>')
  assert(first and timeline:sub(opening-1, opening) ~= '/>', 'First Timecode track unavailable')
  local track = assert(timeline:sub(opening+1):match('^(.-)</Track>'), 'Incomplete first track')
  local object = assert(track:match('<Object[%s>](.-)</Object>'), 'First track has no executor')
  local page, slot = object:match('<No>%s*30%s*</No>%s*<No>%s*1%s*</No>%s*<No>%s*(%d+)%s*</No>%s*<No>%s*(%d+)%s*</No>')
  assert(page and tonumber(page) .. '.' .. tonumber(slot) == addr, 'First Timecode track changed')
  local assignment = assert(export('Executor ' .. addr, temp .. '_exec'):match('<Assignment[%s>](.-)</Assignment>'), 'First track executor has no sequence')
  local seq = tonumber(assignment:match('<No>%s*25%s*</No>%s*<No>%s*1%s*</No>%s*<No>%s*(%d+)%s*</No>'))
  assert(seq and (tonumber(expected) == 0 or seq == tonumber(expected)), 'First track sequence changed')
  local dest = 'Sequence ' .. seq
  local ledger = dir .. 'tblink_first_' .. owner .. '_' .. seq .. '.txt'
  local saved = {}
  for key, num, state in (read(ledger) or ''):gmatch('(%x+) ([%d%.]+) (%a+)\n') do saved[key] = {cue=num,state=state} end
  local function record(points, state)
    if #points == 0 then return end
    local f = assert(io.open(ledger, 'ab'))
    for _, point in ipairs(points) do assert(f:write(point.key .. ' ' .. point.cue .. ' ' .. state .. '\n')) end
    assert(f:close())
  end
  local list, seen, reply = {}, {}, {}
  local blank, needs_write = false, false
  local function proof(key) return dir .. 'tblink_first_' .. owner .. '_' .. seq .. '_' .. key .. '.cue' end
  for line in rows:gmatch('[^\n]+') do
    local key, refs = line:match('^(%x+) (.+)$')
    assert(key and #key == 64 and not seen[key], 'Duplicate or invalid Cue')
    seen[key] = true
    local sources = {}
    for pair in refs:gmatch('[^,]+') do
      local base, mask = pair:match('^(.-)~([%x+]+)$')
      local from, number, mode = (base or pair):match('^(%d+) ([%d%.]+)([ts]?)$')
      from = tonumber(from)
      assert(from and from <= 99999 and tonumber(number) and tonumber(number) <= 9999.999, 'Invalid Cue reference')
      if from > 0 then
        sources[#sources+1] = {seq=from, cue=number, mode=mode, mask=mask}
      else assert(refs == '0 0', 'Invalid empty Cue') end
    end
    assert(#sources <= 32, 'Too many Cue ingredients')
    local pos = #reply + 1
    reply[pos] = ''
    if #sources == 1 and sources[1].seq == seq and sources[1].mode == '' and not sources[1].mask then
      assert(obj.handle(dest .. ' Cue ' .. sources[1].cue), 'Source Cue missing')
      reply[pos] = sources[1].cue
    elseif saved[key] and obj.handle(dest .. ' Cue ' .. saved[key].cue) then
      list[#list+1] = {key=key, sources=sources, pos=pos, existing=saved[key].cue,
        witness=saved[key].state == 'done' and read(proof(key)) or nil}
    else
      needs_write = true
      list[#list+1] = {key=key, sources=sources, pos=pos}
      if #sources == 0 then blank = true end
    end
  end
  assert(#reply > 0 and #reply <= 9999, 'Invalid point count')
  local backup
  if #list > 0 then
    for _, point in ipairs(list) do
      if not point.witness then
        for _, source in ipairs(point.sources) do assert(obj.handle('Sequence ' .. source.seq .. ' Cue ' .. source.cue), 'Source Cue missing') end
      end
    end
    backup = needs_write and ('tblink_backup_' .. id) or nil
    local function number_key(number) return math.floor(tonumber(number)*1000 + 0.5) end
    local before_cues, source_cues = {}, {[seq]={}}
    for _, point in ipairs(list) do
      if point.existing then
        before_cues[number_key(point.existing)] = true
        source_cues[seq][number_key(point.existing)] = true
      end
      for _, source in ipairs(point.sources) do
        source_cues[source.seq] = source_cues[source.seq] or {}
        source_cues[source.seq][number_key(source.cue)] = true
      end
    end
    local original = export(dest, backup or (temp .. '_check'), needs_write, source_cues[seq])
    local source_data = first_cue_data(original, before_cues)
    for _, point in ipairs(list) do
      if point.witness then
        assert(before_cues[number_key(point.existing)] == point.witness, '控台上这个编号的 Cue 内容已经改变，请重新读取当前节目的时间线')
      end
    end
    local tracked, requested, tracked_xml = {}, {}, {}
    for _, point in ipairs(list) do
      if not point.witness then for _, source in ipairs(point.sources) do
        if source.mode == 't' then
          requested[source.seq] = requested[source.seq] or {}
          requested[source.seq][number_key(source.cue)] = true
        end
      end end
    end
    for number, wanted in pairs(requested) do
      guard()
      local xml = number == seq and original or export('Sequence ' .. number, temp .. '_before', false, {})
      tracked_xml[number] = tracked_cues(number, wanted, xml, 'tblink_status_' .. id)
      tracked[number] = first_cue_data(tracked_xml[number])
    end
    local material_sources = {}
    for _, point in ipairs(list) do
      if not point.witness then for _, source in ipairs(point.sources) do
        if source.mask then
          local xml = source.mode == 't' and tracked_xml[source.seq] or material_sources[source.seq]
          if not xml then
            xml = source.seq == seq and original or export('Sequence ' .. source.seq, temp .. '_material', false, source_cues[source.seq])
            material_sources[source.seq] = xml
          end
          source.projected = material_cue(xml, number_key(source.cue), source.mask)
        end
      end end
    end
    local last = 0
    for n, sub in original:gmatch('<Number%s+number="(%d+)"%s+sub_number="(%d+)"') do last = math.max(last, tonumber(n) * 1000 + tonumber(sub)) end
    local function next_number()
      local n = (math.floor(last / 1000) + 1) * 1000
      if n > 9999000 then n = last + 1 end
      assert(n <= 9999999, 'First track has no free trailing Cue number')
      last = n
      if n % 1000 == 0 then return tostring(n / 1000):gsub('%.0$', '') end
      return string.format('%d.%03d', math.floor(n / 1000), n % 1000)
    end
    local header = assert(original:match('(<MA%s[^>]+>)'), 'Sequence header unavailable')
    local function skeleton(n)
      return '<Cue xsi:nil="true"/><Cue index="1"><Number number="' .. n .. '" sub_number="0"/><CuePart index="0"/></Cue>'
    end
    -- A zero-step native sequence must be initialized before MA2 Copy (onPC 3.7).
    local zero = not original:find('<Number[%s>]')
    local scratch
    if blank then
      scratch = 9989
      while scratch > 0 and obj.handle('Sequence ' .. scratch) do scratch = scratch - 1 end
      assert(scratch > 0, 'No temporary sequence slot')
    end
    guard()
    local ok, err = pcall(function()
      if scratch then
        write(dir .. temp .. '.xml', header .. '<Sequ index="' .. (scratch-1) .. '" name="' .. temp .. '">' .. skeleton(1) .. '</Sequ></MA>')
        assert(not obj.handle('Sequence ' .. scratch), 'Temporary slot occupied')
        gma.cmd('Import ' .. temp .. '.xml At Sequence ' .. scratch .. ' /nc')
        assert(obj.label(assert(obj.handle('Sequence ' .. scratch))) == temp and obj.handle('Sequence ' .. scratch .. ' Cue 1'), 'Empty Cue source unavailable')
      end
      local reserved = {}
      for _, point in ipairs(list) do
        point.cue = point.existing or next_number()
        if not point.existing then
          assert(not obj.handle(dest .. ' Cue ' .. point.cue), 'Cue number occupied')
          reserved[#reserved+1] = point
        end
      end
      record(reserved, 'pending')
      for _, point in ipairs(list) do
        guard()
        local cue = point.cue
        if not point.existing then
          assert(not obj.handle(dest .. ' Cue ' .. cue), 'Cue number occupied')
          if zero then
            local init = original:gsub('<Cue%s+xsi:nil="true"%s*/>', '')
            if not init:find('</Sequ>', 1, true) then init = init:gsub('(<Sequ%s+[^>]-)%s*/>', '%1></Sequ>', 1) end
            init = init:gsub('</Sequ>', skeleton(cue) .. '</Sequ>', 1)
            write(dir .. temp .. '_init.xml', init)
            gma.cmd('Import ' .. temp .. '_init.xml At ' .. dest .. ' /o /nc')
            discard(temp .. '_init'); assert(obj.handle(dest .. ' Cue ' .. cue), 'First Cue initialization failed'); zero = false
          end
          local copies = #point.sources > 0 and point.sources or {{seq=scratch,cue='1'}}
          for i, source in ipairs(copies) do
            local mode = (source.mode == 't' and ' /status=true' or ' /status=false') .. (i == 1 and ' /o /nc' or ' /merge /nc')
            if source.projected then
              copy_material(source.projected, source.cue, dest .. ' Cue ' .. cue, i == 1 and ' /o /nc' or ' /merge /nc', temp .. '_pick')
            else gma.cmd('Copy Sequence ' .. source.seq .. ' Cue ' .. source.cue .. ' At ' .. dest .. ' Cue ' .. cue .. mode) end
            assert(obj.handle(dest .. ' Cue ' .. cue), 'Copied Cue missing on readback')
          end
        end
        point.cue = cue; reply[point.pos] = cue
      end
      local after_cues = before_cues
      local actual = source_data
      if needs_write then
        after_cues = {}
        for _, point in ipairs(list) do after_cues[number_key(point.cue)] = true end
        actual = first_cue_data(export(dest, temp .. '_read', false, after_cues), after_cues)
      end
      local sources = {[seq]=source_data}
      local function payload(index, number)
        return assert(index[number_key(number)], 'Numbered Cue not found in native readback')
      end
      for _, point in ipairs(list) do
        if point.witness then
          assert(payload(after_cues, point.cue) == point.witness, '控台上的 Cue 在同步期间改变，请重新读取当前节目的时间线')
        else
          local target = payload(actual, point.cue)
          local wanted, layers = '', {}
          for _, source in ipairs(point.sources) do
            if source.projected then wanted = payload(first_cue_data(source.projected), source.cue)
            elseif source.mode == 't' then wanted = payload(tracked[source.seq], source.cue)
            else
              sources[source.seq] = sources[source.seq] or first_cue_data(export('Sequence ' .. source.seq, temp .. '_src', false, source_cues[source.seq]))
              wanted = payload(sources[source.seq], source.cue)
            end
            if #point.sources > 1 then first_cue_layers(layers, wanted) end
          end
          if #point.sources > 1 then
            local native = {}
            first_cue_layers(native, target)
            assert(same_first_layers(layers, native) and same_first_layers(native, layers), 'Combined Cue fixture data differs')
          else assert(target == wanted, 'Copied Cue fixture data differs') end
          write(proof(point.key), payload(after_cues, point.cue))
        end
      end
      local confirmed = {}
      for _, point in ipairs(list) do if not point.witness then confirmed[#confirmed+1] = point end end
      record(confirmed, 'done')
    end)
    local temporary = scratch and obj.handle('Sequence ' .. scratch)
    if temporary and obj.label(temporary) == temp then gma.cmd('Delete Sequence ' .. scratch .. ' /nc') end
    discard(temp)
    assert(ok, err)
  end
  return '{"sequence":' .. seq .. ',"executor":"' .. addr .. '","cues":["' .. table.concat(reply, '","') .. '"],"backupFile":' .. (backup and ('"' .. backup .. '.xml"') or 'null') .. '}'
end
local function start(data, previous)
  local id, op, target, size, body = data:match('^([a-f0-9]+)\n([A-Z]+)\n(%d+)\n(%d+)\n(.*)$')
  assert(id and #id == 32 and id ~= last, 'Invalid or already processed request')
  last = id
  local job = { id = id, steps = {}, done = 0 }
  local inventory = op == 'LIST' or op == 'LISTSEQ' or op == 'TCRANGES'
  local source = inventory and gma.show.getvar('SHOWFILE')
  local function step(fn)
    if not inventory then job.steps[#job.steps + 1] = fn; return end
    -- MA yields Lua at its instruction quota. Scanning 10,000 mostly empty
    -- slots used to wait a console tick at every quota. Resume the same read
    -- within a short budget; return a bridge step so playback can interrupt.
    local scan = coroutine.create(fn)
    local function resume()
      assert(gma.show.getvar('SHOWFILE') == source and _G.TBLINK_BRIDGE_GENERATION == generation, 'Show or session changed during directory read')
      local deadline = gma.gettime() + 0.025
      local resumes = 0
      repeat
        local ok, error_text = coroutine.resume(scan)
        assert(ok, error_text)
        if coroutine.status(scan) == 'dead' then return end
        resumes = resumes + 1
      until not job.exporting and (resumes >= 128 or gma.gettime() >= deadline)
      table.insert(job.steps, 1, resume)
    end
    job.steps[#job.steps + 1] = resume
  end
  local function answer(value) job.result = value end
  step(function()
    local tc = tonumber(target)
    assert(tc and tc >= 1 and tc <= 99999 and tc == math.floor(tc), 'Invalid Timecode')
    assert(#body == tonumber(size), 'Request length mismatch')
    -- steps=1: this bridge answers 'run' with STEP:<k> when asked to, and takes 'step'.
    if op == 'PING' then return answer((gma.show.getvar('VERSION') or 'unknown') .. '\nsteps=1') end
    if op == 'FIRSTCUES' then return answer(first_track_cues(tc, id, body)) end
    -- Removes write-before backups the program's ledger rotated out; answers with the names now gone.
    if op == 'DISCARD' then
      assert(#body > 0 and #body <= 4096, 'Invalid backup list')
      local gone = {}
      for name in body:gmatch('[^,]+') do
        assert(name:match('^tblink_backup_%x+$') or name:match('^tblink_label_%x+$') or name:match('^tblink_library_%x+$'), 'Invalid backup name')
        local removed, reason = os.remove(root .. '/importexport/' .. name .. '.xml')
        if removed or tostring(reason):find('No such file', 1, true) then gone[#gone + 1] = name end
      end
      return answer(table.concat(gone, ','))
    end
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
      return answer('{"show":' .. quote(gma.show.getvar('SHOWFILE')) .. ',"generation":' .. quote(generation) .. ',"version":' .. quote(gma.show.getvar('VERSION')) .. ',"buttonPage":' .. assert(tonumber(gma.show.getvar('BUTTONPAGE'))) .. ',"faderPage":' .. assert(tonumber(gma.show.getvar('FADERPAGE'))) .. ',"pages":[' .. table.concat(entries, ',') .. ']}')
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
      local metadata, seen, sequences = {}, {}, {}
      for assignment in xml:gmatch('<Assignment%s[^>]*>(.-)</Assignment>') do
        local numbers = {}; for number in assignment:gmatch('<No>%s*(%d+)%s*</No>') do numbers[#numbers + 1] = tonumber(number) end
        local sequence = #numbers == 3 and numbers[1] == 25 and numbers[2] == 1 and numbers[3] or nil
        if sequence and not seen[sequence] then
          seen[sequence] = true
          sequences[#sequences + 1] = sequence
        end
      end
      local function collect()
        answer((xml:gsub('</MA>%s*$', function() return '<tblink_sequences>' .. table.concat(metadata) .. '</tblink_sequences></MA>' end)))
      end
      if #sequences == 0 then return collect() end
      -- One step per assigned Sequence: its appearance may need an export.
      for position, sequence in ipairs(sequences) do
        step(function()
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
          if position == #sequences then collect() end
        end)
      end
      return
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
      -- One step: the backup export, the checks and the Label belong together.
      local backup = 'tblink_label_' .. id
      gma.cmd('Export Sequence ' .. tc .. ' "' .. backup .. '" /o')
      local file = assert(io.open(root .. '/importexport/' .. backup .. '.xml', 'rb'), 'Name backup unavailable')
      local first = file:read(1); file:close(); assert(first, 'Name backup empty')
      assert(obj.handle(address) == handle and (label() == previous or label() == name), 'Rename target changed during backup')
      assert(show == gma.show.getvar('SHOWFILE') and session == generation, 'Show changed during backup')
      if label() ~= name then gma.cmd('Label ' .. address .. ' "' .. name .. '"') end
      assert(label() == name, 'Name readback differs; write unconfirmed')
      local function quote(value)
        return '"' .. value:gsub('[%z\1-\31\\"]', function(char) return string.format('\\u%04x', string.byte(char)) end) .. '"'
      end
      return answer('{"sequence":' .. tc .. ',"kind":' .. quote(kind) .. ',"cue":' .. quote(cue) .. ',"show":' .. quote(show) .. ',"generation":' .. quote(session) .. ',"name":' .. quote(label()) .. ',"backupFile":' .. quote(backup .. '.xml') .. '}')
    end
    if op == 'ASSIGNSEQ' then
      local with_name = body:sub(-5) == '\nname'
      if with_name then body = body:sub(1, -6) end
      local owner, show_hex, session_hex = body:match('^([a-f0-9]+)\n([a-f0-9]+)\n([a-f0-9]+)$')
      assert(owner and #owner == 24 and #show_hex % 2 == 0 and #session_hex % 2 == 0, 'Invalid automatic assignment')
      local function decode(value) return value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end) end
      local show, session = decode(show_hex), decode(session_hex)
      local function same_show()
        assert(show == gma.show.getvar('SHOWFILE') and session == generation and _G.TBLINK_BRIDGE_GENERATION == generation, 'Show or session changed')
      end
      same_show()
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
      local function reply(address)
        same_show()
        local name = ''
        if with_name then
          local value = assert(obj.name(assert(obj.handle('Executor ' .. address))), 'Executor name unavailable')
          name = ',"executorName":"' .. value:gsub('[%z\1-\31\\"]', function(c) return string.format('\\u%04x', c:byte()) end) .. '"'
        end
        answer('{"sequence":' .. tc .. ',"executor":"' .. address .. '"' .. name .. '}')
      end
      local function confirm()
        assert(obj.handle('Executor ' .. free_address) and assigned(free_address) == tc, 'Sequence assignment unconfirmed')
        reply(free_address)
      end
      -- The write is one step: page creation, the checks and the Assign; the readback is the next.
      local function assign()
        same_show()
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
        step(confirm)
      end
      -- A dedicated page avoids touching operators' physical faders and occupied slots.
      -- The search goes on where the last step stopped; each occupied slot is one export, one step.
      local page, number = 999, nil
      local function search()
        while page >= 900 do
          if not number then
            local handle = obj.handle('Page ' .. page)
            if not handle then free_page = free_page or page
            elseif obj.label(handle) == label then number = 101 end
          end
          while number and number <= 120 do
            local address = page .. '.' .. number
            number = number + 1
            if not obj.handle('Executor ' .. address) then
              if not free_address then free_address = address; free_exec = page end
            else
              if assigned(address) == tc then
                return reply(address)
              end
              return step(search)
            end
          end
          page = page - 1; number = nil
        end
        step(assign)
      end
      return search()
    end
    if op == 'LIST' or op == 'LISTSEQ' then
      local markers = body == 'selector'
      local scoped = op == 'LISTSEQ' and body ~= '' and not markers
      assert(body == '' or markers or scoped and #body <= 60000 and not body:find('[^%d,]'), 'Invalid directory scope')
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
      local function append(child, expected)
        if child then
          local internal = gma.show.property.get(child, 'Info') == 'TBLINK_MTC_SELECTOR_V1'
          if markers and not internal then return end
          local number = tonumber(obj.number(child))
          assert(number and number >= 1 and number <= 99999 and number == math.floor(number) and not seen[number], 'Invalid Timecode directory number')
          assert(not expected or number == expected, 'Sequence number changed')
          seen[number] = true
          entries[#entries + 1] = '{"target":' .. number .. ',"name":' .. quote(assert(obj.name(child), 'Timecode name unavailable')) .. (internal and ',"internal":true' or '') .. '}'
          assert(#entries <= 10000, 'Occupied Timecode directory exceeds limit')
        end
      end
      if scoped then
        if body ~= '0' then
          for value in (body .. ','):gmatch('(.-),') do
            local number = tonumber(value)
            assert(number and number >= 1 and number <= 99999 and tostring(number) == value, 'Invalid sequence number')
            append(obj.handle('Sequence ' .. value), number)
          end
        end
      else
        -- Native pools are sparse: amount is the indexed span, not occupied slots.
        for index = 0, count - 1 do
          append(obj.child(pool, index))
          if index % 256 == 255 then coroutine.yield() end
        end
      end
      assert(obj.amount(pool) == count, 'Timecode directory changed during read')
      return answer('{"show":' .. quote(assert(gma.show.getvar('SHOWFILE'), 'Show identity unavailable')) .. ',"generation":' .. quote(generation) .. ',"version":' .. quote(assert(gma.show.getvar('VERSION'))) .. ',"entries":[' .. table.concat(entries, ',') .. ']}')
    end
    -- Where every Timecode show sits in time: offset, length, slot, frame format and the last event,
    -- read from an export made and removed on the console, so no event data crosses the network.
    if op == 'TCRANGES' then
      local wanted
      if body ~= '' and body ~= 'editing' then
        local targets = assert(body:match('^playback:([%d,]+)$'), 'Invalid playback range request')
        assert(#targets <= 60000, 'Too many playback targets')
        wanted = {}
        local seen = {}
        for value in (targets .. ','):gmatch('(.-),') do
          local n = tonumber(value)
          assert(n and n >= 1 and n <= 99999 and tostring(n) == value and not seen[n], 'Invalid playback target')
          seen[n] = true; wanted[#wanted + 1] = n
        end
      end
      local obj = gma.show.getobj
      -- assert returns all of its arguments on success. Do not pass its error text as a second
      -- argument to MA's native amount(), which rejects that call on onPC 3.7.
      local pool = assert(obj.handle('Timecode'), 'Object pool unavailable')
      local count = assert(obj.amount(pool), 'Timecode enumeration unavailable')
      assert(count >= 0 and count <= 100000, 'Timecode directory exceeds limit')
      local function quote(value)
        return '"' .. tostring(value):gsub('[%z\1-\31\\"]', function(char) return string.format('\\u%04x', string.byte(char)) end) .. '"'
      end
      local entries = {}
      -- One export per Timecode show, one step each; the pool is looked up again in every step.
      local index, limit = 0, wanted and #wanted or count
      local function ranges()
        local pool = assert(obj.handle('Timecode'), 'Object pool unavailable')
        while index < limit do
          local child
          if wanted then child = obj.handle('Timecode ' .. wanted[index + 1]) else child = obj.child(pool, index) end
          index = index + 1
          if not child and index % 256 == 0 then coroutine.yield() end
          if child then
            local number = tonumber(obj.number(child))
            assert(number and number >= 1 and number <= 99999 and number == math.floor(number), 'Invalid Timecode directory number')
            assert(not wanted or wanted[index] == number, 'Timecode number changed')
            local name = 'tblink_tcrange_' .. id
            -- Finish this single native export and close its file before a
            -- cancellation can release the request at a network step boundary.
            job.exporting = true; job.close = function() discard(name) end
            gma.cmd('Export Timecode ' .. number .. ' "' .. name .. '" /o')
            local xml = assert(read(root .. '/importexport/' .. name .. '.xml'), 'Timecode export unavailable')
            discard(name)
            job.close = nil; job.exporting = nil
            local tag = xml:match('<Timecode%s[^>]*>') or ''
            local function attribute(key) return tag:match('%s' .. key .. '="([^"]*)"') end
            local last = nil
            for event in xml:gmatch('<Event%s[^>]*>') do
              local time = tonumber(event:match('%stime="([%d%.]+)"') or '0')
              if time and (not last or time > last) then last = time end
            end
            -- Only report the cheap no-change case for ordinary native XML. If the
            -- shape is unfamiliar or any playback attribute is present, the desktop
            -- reads the complete object through its normal validation/write path.
            local ready = ''
            if wanted and tonumber(attribute('index')) == number - 1 and not xml:find('<!', 1, true)
              and xml:find('xmlns="http://schemas.malighting.de/grandma2/xml/MA"', 1, true)
              and not xml:find('<[%w_%-]+:') and not xml:find('<Cue/>', 1, true) and not xml:find('<Cue%s[^>]-/>') and not xml:find('<Timecode%s', (xml:find('<Timecode%s') or 0) + 1)
              and not attribute('m_autostart') and not attribute('no_status_call') and not attribute('no_switch_off') then
              local ok, refs = pcall(references, xml)
              if ok and #refs <= 10000 then ready = ',"readySequences":[' .. table.concat(refs, ',') .. ']' end
            end
            entries[#entries + 1] = '{"target":' .. number .. ',"name":' .. quote(attribute('name') or '') .. ',"offset":' .. quote(attribute('offset') or '0') .. ',"length":' .. quote(attribute('lenght') or '')
              .. ',"slot":' .. quote(attribute('slot') or '') .. ',"frame":' .. quote(attribute('frame_format') or '') .. ',"last":' .. quote(last and tostring(last) or '') .. ready .. (gma.show.property.get(child, 'Info') == 'TBLINK_MTC_SELECTOR_V1' and ',"internal":true' or '') .. '}'
            assert(#entries <= 10000, 'Occupied Timecode directory exceeds limit')
            if index < limit then return step(ranges) end
          end
        end
        assert(obj.amount(pool) == count, 'Timecode directory changed during read')
        answer('{"show":' .. quote(assert(gma.show.getvar('SHOWFILE'), 'Show identity unavailable')) .. (body ~= '' and ',"generation":' .. quote(generation) or '') .. ',"entries":[' .. table.concat(entries, ',') .. ']}')
      end
      return ranges()
    end
    if op == 'SEQGO' then
      local show_hex, generation_hex = body:match('^([a-f0-9]+)\n([a-f0-9]+)$')
      assert(show_hex and #show_hex % 2 == 0 and #generation_hex % 2 == 0, 'Invalid Cue trigger preparation source')
      local function unhex(value) return value:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end) end
      local function check_source()
        assert(gma.show.getvar('SHOWFILE') == unhex(show_hex) and generation == unhex(generation_hex), 'Show or session changed during trigger preparation')
      end
      check_source()
      assert(gma.show.getobj.handle('Sequence ' .. tc), 'Sequence missing')
      local name = 'tblink_library_' .. id
      local path = root .. '/importexport/' .. name .. '.xml'
      local bytes, tokens, cues = 0, 0, nil
      local work = { files = {} }
      work.checkpoint = function(size, count)
        bytes = bytes + size; tokens = tokens + count
        if bytes >= 4194304 or tokens >= 256 then coroutine.yield('tblink_step') end
      end
      job.close = function()
        for file in pairs(work.files) do file:close(); work.files[file] = nil end
      end
      local scan = coroutine.create(function()
        gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '" /o')
        coroutine.yield('tblink_step')
        cues = sequence_triggers(path, tc, work)
        gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '_verify" /o')
        coroutine.yield('tblink_step')
        assert(same_sequence_files(path, root .. '/importexport/' .. name .. '_verify.xml', false, work), 'Sequence changed before trigger preparation; backup ' .. name)
        discard(name .. '_verify')
        if #cues == 0 then discard(name); return answer('{"changed":false,"cues":0}') end
        coroutine.yield('tblink_write')
        local check = root .. '/importexport/' .. name .. '_verify.xml'
        assert(#sequence_triggers(check, tc, work) == 0 and same_sequence_files(path, check, true, work), 'Sequence changed after trigger preparation; backup ' .. name)
        discard(name .. '_verify')
        answer('{"changed":true,"cues":' .. #cues .. '}')
      end)
      local function resume()
        check_source(); bytes = 0; tokens = 0
        local until_time = gma.gettime() + 0.1
        -- MA itself also yields coroutines at its instruction quota. Do not turn
        -- each of those tiny pauses into a network round trip. Still bound each
        -- request by elapsed console time as well as bytes/metadata tokens.
        repeat
          local ok, result = coroutine.resume(scan)
          assert(ok, result)
          if result == 'tblink_write' then
            -- Keep the sole write outside the scan coroutine: MA's own implicit
            -- yields must never split Assign from the phase acknowledgement.
            -- Preflight's final chunk and this write remain the same RPC step.
            check_source()
            gma.cmd('Assign Sequence ' .. tc .. ' Cue ' .. table.concat(cues, ' + ') .. ' /Trig=Go')
            job.confirming = true
            gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '_verify" /o')
            break
          end
          if result == 'tblink_step' then break end
        until coroutine.status(scan) == 'dead' or gma.gettime() >= until_time
        if coroutine.status(scan) ~= 'dead' then step(resume) end
      end
      return resume()
    end
    if op == 'SEQUENCE' then
      assert(body == '' or body == 'keep', 'Sequence request must be empty or keep')
      assert(gma.show.getobj.handle('Sequence ' .. tc), 'Sequence missing')
      local name = 'tblink_library_' .. id
      gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '" /o')
      local xml = assert(read(root .. '/importexport/' .. name .. '.xml'), 'Sequence export unavailable')
      return step(function()
        gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '_verify" /o')
        assert(canonical(xml) == canonical(assert(read(root .. '/importexport/' .. name .. '_verify.xml'))), 'Sequence changed during read')
        discard(name .. '_verify')
        if body ~= 'keep' then discard(name) end
        answer(xml)
      end)
    end
    if op == 'SEQCUES' then
      -- The complete export stays on the console; only the requested Cue elements cross the network.
      local names_show, names_gen, rest = body:match('^names:(%x+):(%x+):(.+)$')
      local identified = gma.show.getvar('SHOWFILE')
      local function identity() assert(gma.show.getvar('SHOWFILE') == identified and generation == _G.TBLINK_BRIDGE_GENERATION, 'Show or session changed') end
      if names_show then
        assert(attr_hex(identified) == names_show and attr_hex(generation) == names_gen, 'Show or session changed')
        body = rest
      end
      local token, mask, pick_show, pick_gen, selected = body:match('^pick:(%x+):([%x+]+):(%x+)%-(%x+):(.+)$')
      if token then
        assert(#token == 32, 'Invalid selection')
        assert(attr_hex(identified) == pick_show and attr_hex(generation) == pick_gen, 'Show or session changed')
        body = selected
      end
      local status = body:sub(1,7) == 'status:'
      if status then body = body:sub(8) end
      local saved = token and body:sub(1,6) == 'saved:'
      if saved then body = body:sub(7) end
      local archive = (status or saved) and body:match('^(%x+):')
      if archive then
        assert(#archive == 32, 'Invalid saved sequence')
        body = body:sub(#archive+2)
      end
      assert(#body > 0 and #body <= 65536 and not body:find('[^%d%.,]'), 'Invalid Cue list')
      local wanted = {}
      for value in body:gmatch('[^,]+') do
        local whole, fraction = value:match('^(%d+)%.(%d%d%d)$')
        assert(whole, 'Invalid Cue number')
        wanted[tonumber(whole) * 1000 + tonumber(fraction)] = true
      end
      local function finish_material(xml)
        identity()
        local n = next(wanted)
        assert(n and not next(wanted, n), 'Select one Cue')
        local filtered, names = material_cue(xml, n, mask)
        if names_show then return answer('attributes:' .. names) end
        write(root .. '/importexport/tblink_pick_' .. token .. '.xml', filtered)
        answer(filtered)
      end
      if archive then
        local xml
        if saved then
          xml = cue_selection(root .. '/importexport/tblink_archive_' .. archive .. '.xml', wanted)
          assert(tonumber(xml:match('<Sequ%s[^>]-index="(%d+)"')) == tc-1, 'Saved sequence identity changed')
          discard('tblink_archive_' .. archive)
        else xml = archived_tracked_cues(tc, wanted, archive, id) end
        if token or names_show then return finish_material(xml) end
        return answer(xml)
      end
      assert(gma.show.getobj.handle('Sequence ' .. tc), 'Sequence missing')
      local name = 'tblink_library_' .. id
      gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '" /o')
      local path = root .. '/importexport/' .. name
      local xml = cue_selection(path .. '.xml', wanted)
      return step(function()
        gma.cmd('Export Sequence ' .. tc .. ' "' .. name .. '_verify" /o')
        assert(same_sequence_files(path .. '.xml', path .. '_verify.xml', false), 'Sequence changed during read')
        discard(name .. '_verify')
        if status then
          local result = tracked_cues(tc, wanted, xml, 'tblink_status_' .. id)
          discard(name)
          if token or names_show then return finish_material(result) end
          return answer(result)
        end
        if token or names_show then discard(name); return finish_material(xml) end
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
        answer(table.concat(parts, '\n'))
      end)
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
      return step(function()
        gma.cmd('Export ' .. address .. ' "' .. name .. '_verify" /o')
        local check = assert(read(root .. '/importexport/' .. name .. '_verify.xml'), 'Executor verification unavailable')
        assert(canonical(xml) == canonical(check), 'Executor changed during read')
        discard(name); discard(name .. '_verify')
        assert(gma.show.getobj.name(assert(gma.show.getobj.handle(address))) == executor_name, 'Executor name changed during read')
        local escaped = executor_name:gsub('&', '&amp;'):gsub('"', '&quot;'):gsub('<', '&lt;'):gsub('>', '&gt;'):gsub('\r', '&#13;'):gsub('\n', '&#10;'):gsub('\t', '&#9;')
        local result, count = xml:gsub('<Exec%s', function() return '<Exec tblink_executor_name="' .. escaped .. '" ' end)
        assert(count == 1, 'Executor export must contain one object')
        answer(result)
      end)
    end
    if op == 'CREATE' then
      assert(not gma.show.getobj.handle('Timecode ' .. tc), 'Timecode already exists; creation refused')
      local length, desired = body:match('^(%d+)\n(.*)$')
      assert(length == '0' and #desired > 0 and #desired <= 65536, 'Invalid creation payload')
      assert(not desired:find('<!DOCTYPE') and not desired:find('<!ENTITY') and not desired:find('<Track') and not desired:find('<Sequ'), 'New Timecode must be empty')
      local index = desired:match('<Timecode%s[^>]-index="(%d+)"')
      assert(tonumber(index) == tc - 1, 'Creation target mismatch')
      -- The write is this step; the readback export is the next.
      local name = 'tblink_create_' .. id
      write(root .. '/importexport/' .. name .. '.xml', desired)
      assert(not gma.show.getobj.handle('Timecode ' .. tc), 'Timecode appeared before creation')
      gma.cmd('Import "' .. name .. '.xml" At Timecode ' .. tc .. ' /nc')
      assert(gma.show.getobj.handle('Timecode ' .. tc), 'Timecode creation unconfirmed')
      discard(name)
      return step(function() answer(export_scratch(tc, 'tblink_created_' .. id)) end)
    end
    assert(gma.show.getobj.handle('Timecode ' .. tc), 'Timecode does not exist')
    if op == 'READ' then return answer(export_scratch(tc, 'tblink_read_' .. id)) end
    if op == 'SNAPSHOT' then return snapshot(step, tc, id, nil, answer, previous) end
    if op == 'SCOPE' then
      assert(#body > 0 and not body:find('[^%d,]') and not body:find(',,') and body:sub(1, 1) ~= ',' and body:sub(-1) ~= ',', 'Invalid Sequence scope')
      local additional, seen = {}, {}
      for value in body:gmatch('[^,]+') do
        local number = tonumber(value)
        assert(number and number >= 1 and number <= 99999 and not seen[number], 'Invalid Sequence scope')
        seen[number] = true; additional[#additional + 1] = number
      end
      return snapshot(step, tc, id, additional, answer, previous)
    end
    assert(op == 'APPLY' or op == 'SYNC', 'Unknown operation')
    local length, rest = body:match('^(%d+)\n(.*)$')
    assert(length, 'Missing expected snapshot')
    length = tonumber(length)
    local expected = rest:sub(1, length)
    local desired = rest:sub(length + 1)
    assert(#desired > 0 and not desired:find('<!DOCTYPE') and not desired:find('<!ENTITY'), 'Invalid XML')
    local name = 'tblink_write_' .. id
    -- The write is one step, never split: backup export, compare, write the file, Import.
    local function write_step()
      local backup = export(tc, 'tblink_backup_' .. id)
      if op == 'SYNC' then
        assert(backup:match('(<Timecode%s.-</Timecode>)') == expected:match('(<Timecode%s.-</Timecode>)'), 'Timecode changed before write')
      else
        assert(canonical(backup) == canonical(expected), 'Timecode changed after preview')
      end
      write(root .. '/importexport/' .. name .. '.xml', desired)
      gma.cmd('Import "' .. name .. '.xml" At Timecode ' .. tc .. ' /o /nc')
      step(function()
        local verified = export_scratch(tc, 'tblink_verify_' .. id)
        discard(name)
        answer(verified)
      end)
    end
    if op == 'SYNC' then
      -- The preflight snapshot is steps of its own; the write is the step after its last one.
      return snapshot(step, tc, id .. '_preflight', references(desired), function(current)
        assert(canonical(current) == canonical(expected), 'Timecode or Sequence changed after preview')
        step(write_step)
      end, previous)
    end
    write_step()
  end)
  return job
end
-- Runs the next step. A failed step ends the request with the same ERROR answer as before steps.
local function advance(job)
  local ok, result = pcall(table.remove(job.steps, 1))
  job.done = job.done + 1
  if ok and #job.steps > 0 then return end
  if job.close then job.close(); job.close = nil end
  job.steps = {}
  local output = tostring(ok and job.result or result)
  job.response = job.id .. '\n' .. (ok and 'OK' or 'ERROR') .. '\n' .. #output .. '\n' .. output
end
-- The local file bridge answers a request file in one go.
local function process(data)
  local job = start(data)
  repeat advance(job) until job.response
  return job.response
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
-- Two lanes, one request each: 'bg' for syncs and long reads, 'fg' for short reads an operator waits
-- for (a page, the directory, one executor), run whole between two steps of the 'bg' request. Each
-- lane expires on its own. A 'begin' that names no lane (a program before lanes, the bridge upgrade
-- check) takes 'bg' and needs both lanes free, as the one request it was before.
local lanes = { bg = nil, fg = nil }
local foreground = { PING = true, PAGES = true, PAGE = true, LIST = true, LISTSEQ = true, EXECUTOR = true }
local snapshot_cache, last_read = nil, nil
-- Expand the optional wire representation before the ordinary full SYNC
-- preflight, backup, import and readback. The frozen native XML remains its baseline.
local function expand_delta(base, delta, size)
  local pieces, pos, bytes = {}, 1, 0
  while pos <= #delta do
    local finish = assert(delta:find('\n', pos, true), 'Incomplete snapshot delta')
    assert(finish - pos <= 24 and #pieces < 4096, 'Invalid snapshot delta')
    local header = delta:sub(pos, finish - 1)
    local from, count = header:match('^C(%d+),(%d+)$')
    pos = finish + 1
    if from then
      from, count = tonumber(from), tonumber(count)
      assert(count > 0 and from + count <= #base and bytes + count <= size, 'Invalid snapshot range')
      pieces[#pieces + 1] = base:sub(from + 1, from + count)
    else
      count = tonumber(header:match('^L(%d+)$') or '')
      assert(count and count > 0 and pos + count - 1 <= #delta and bytes + count <= size, 'Invalid snapshot literal')
      pieces[#pieces + 1] = delta:sub(pos, pos + count - 1); pos = pos + count
    end
    bytes = bytes + count
  end
  assert(bytes == size, 'Incomplete desired Timecode')
  return table.concat(pieces)
end
-- MA's Lua instruction budget makes a callback per byte very slow. gsub table replacement
-- does the same exact byte conversion in native code, without changing the wire protocol.
local hex_bytes, raw_bytes = {}, {}
for byte = 0, 255 do
  local raw, encoded = string.char(byte), string.format('%02x', byte)
  hex_bytes[raw] = encoded; raw_bytes[encoded] = raw
end
local function hex(data) return (data:gsub('.', hex_bytes)) end
local function clear_transfer(net)
  if net and net.job and net.job.close then net.job.close(); net.job.close = nil end
  if net and net.file then assert(os.remove(net.file), 'Could not remove local response'); net.file = nil end
  if net and net.input then
    local f = io.open(net.input, 'rb')
    if f then f:close(); assert(os.remove(net.input), 'Could not remove local request') end
    net.input = nil
  end
end
local function idle(net) return not net or gma.gettime() > net.expires end
-- The request's answer is ready: keep it for 'read' and say how long it is.
local function finished(network)
  local id = network.id
  network.response = network.job.response; network.job = nil
  assert(#network.response <= 33554500, 'Response exceeds limit')
  if network.op == 'READ' and network == lanes.bg then
    local xml = #network.response <= 524350 and network.response:match('^[a-f0-9]+\nOK\n%d+\n(.*)$')
    local previous = network.previous
    network.previous = nil
    last_read = xml and #xml <= 524288 and {id = id, target = network.target, xml = xml} or nil
    if last_read and previous then
      -- Each check still exports the live Timecode. Native exports often differ
      -- only in their Info timestamp. Compare all remaining bytes and transmit
      -- the actual new prefix so even the timestamp is returned exactly.
      local old_end, new_end = 0, 0
      if previous.xml ~= xml then
        old_end = select(2, previous.xml:sub(1, 2048):find('<Info%s[^<>]-/>'))
        new_end = select(2, xml:sub(1, 2048):find('<Info%s[^<>]-/>'))
      end
      if old_end and new_end and #previous.xml - old_end == #xml - new_end and (old_end == 0 or previous.xml:sub(old_end + 1) == xml:sub(new_end + 1)) then
        network.response = id .. '\nCOPY\n' .. previous.id .. '\n' .. old_end .. '\n' .. #xml .. '\n' .. xml:sub(1, new_end)
      end
    end
  end
  if network.op == 'SNAPSHOT' or network.op == 'SCOPE' then
    local content = network.response:match('^[a-f0-9]+\nOK\n%d+\n(.*)$')
    snapshot_cache = content and { id = id, target = network.target, xml = content } or nil
    if content then
      -- Fixture values are never edited by this application. Keep the complete
      -- export here for SYNC's exact preflight, but send only Cue metadata.
      -- Cue/CuePart attributes and Number remain unchanged for reference checks.
      local compact = content:gsub('<CueDatas%s*>.-</CueDatas>', '')
      if #compact <= 1048576 then snapshot_cache.wire = compact end
      network.response = id .. '\nOK\n' .. #compact .. '\n' .. compact
    end
  end
  if network.local_file and #network.response >= 8192 then
    network.file = root .. '/temp/tblink_network_' .. id .. '.bin'
    write(network.file, network.response)
    return 'FILE:' .. #network.response .. ':' .. hex(network.file)
  end
  return 'DONE:' .. #network.response .. (#network.response >= 8192 and ':batch' or '')
end
-- One step of the request: STEP:<steps done> while more remain, DONE:<size> after the last.
local function proceed(network, token)
  advance(network.job)
  if network.job.response then
    local receipt = finished(network)
    local response = network.response
    if network.inline and #response < 8192 then
      for offset = 1, #response, 256 do
        gma.echo('TBLINK_INLINE_' .. token .. '_' .. string.format('%04x', (offset - 1) / 256) .. ':DATA:' .. hex(response:sub(offset, offset + 255)))
      end
      clear_transfer(network); lanes[lanes.bg == network and 'bg' or 'fg'] = nil
      return 'INLINE:' .. #response
    end
    return receipt
  end
  return 'STEP:' .. network.job.done .. (network.job.confirming and ':verify' or '')
end
_G.TBLINK_NET = function(token, action, id, a, b, c, lane, transport, read_now, delta_size, query, previous_read)
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
      assert(a == 'PING' or a == 'PAGES' or a == 'PAGE' or a == 'LIST' or a == 'LISTSEQ' or a == 'SEQUENCE' or a == 'SEQGO' or a == 'SEQCUES' or a == 'READ' or a == 'SNAPSHOT' or a == 'SCOPE' or a == 'APPLY' or a == 'SYNC' or a == 'CREATE' or a == 'EXECUTOR' or a == 'FIRSTCUES' or a == 'ASSIGNSEQ' or a == 'LABEL' or a == 'DISCARD' or a == 'TCRANGES', 'Invalid operation')
      assert(type(b) == 'number' and b >= 1 and b <= 99999 and b == math.floor(b), 'Invalid target')
      assert(type(c) == 'number' and c >= 0 and c <= 33554432 and c == math.floor(c), 'Invalid payload size')
      assert(lane == nil or lane == 'bg' or lane == 'fg', 'Invalid lane')
      assert(transport == nil or transport == 'file', 'Invalid transport')
      assert(read_now == nil or (read_now == 'read' and action == 'begin' and a == 'READ' and c == 0 and lane == 'bg'), 'Invalid immediate read')
      assert(delta_size == nil or (action == 'beginsync' and transport == nil and c <= 524288 and type(delta_size) == 'number' and delta_size == math.floor(delta_size) and delta_size > 0 and delta_size < c), 'Invalid snapshot delta size')
      assert(query == nil or (action == 'begin' and (a == 'LIST' or a == 'LISTSEQ' or a == 'TCRANGES' or lane == 'bg' and (a == 'SEQGO' or a == 'SNAPSHOT' or a == 'SCOPE' or a == 'FIRSTCUES' or a == 'ASSIGNSEQ')) and type(query) == 'string' and c <= 320 and #query == c * 2 and not query:find('[^a-f0-9]')), 'Invalid inline query')
      assert(previous_read == nil or (read_now == 'read' and type(previous_read) == 'string' and #previous_read == 32 and previous_read:match('^[a-f0-9]+$')), 'Invalid read reference')
      -- Only reads go on 'fg', and none that leaves state for a later request (a snapshot for beginsync).
      assert(lane ~= 'fg' or (action == 'begin' and foreground[a]), 'Operation not allowed on the foreground lane')
      local named = lane ~= nil
      lane = lane or 'bg'
      assert(idle(lanes[lane]) and (named or idle(lanes.fg)), 'Another network request is pending')
      local other = lanes[lane == 'bg' and 'fg' or 'bg']
      assert(not other or other.id ~= id, 'Request already pending')
      clear_transfer(lanes[lane])
      lanes[lane] = { id = id, op = a, target = b, size = c, bytes = 0, chunks = {}, base = base, local_file = transport == 'file', expires = gma.gettime() + 120 }
      if delta_size and snapshot_cache.wire then
        lanes[lane].delta_base = snapshot_cache.wire; lanes[lane].desired_size = c; lanes[lane].size = delta_size
        return 'ACK:lanes:delta'
      end
      if read_now or query then
        local net = lanes[lane]
        local completed, receipt = pcall(function()
          net.done = true; net.chunks = nil; net.inline = true
          if previous_read and last_read and last_read.id == previous_read and last_read.target == b then net.previous = last_read end
          local input = query and query:gsub('..', raw_bytes) or ''
          local previous = (a == 'SNAPSHOT' or a == 'SCOPE') and snapshot_cache and snapshot_cache.target == b and snapshot_cache.xml
          net.job = start(id .. '\n' .. a .. '\n' .. b .. '\n' .. #input .. '\n' .. input, previous)
          return proceed(net, token)
        end)
        if not completed then clear_transfer(net); lanes[lane] = nil; error(receipt) end
        return receipt
      end
      if transport == 'file' and c >= 8192 then
        lanes[lane].input = root .. '/temp/tblink_network_' .. id .. '.input.bin'
        return 'ACK:lanes:file:' .. hex(lanes[lane].input)
      end
      -- A program that names the lane learns from the answer that this bridge has two.
      return named and 'ACK:lanes' or 'ACK'
    end
    local network = (lanes.bg and lanes.bg.id == id and lanes.bg) or (lanes.fg and lanes.fg.id == id and lanes.fg) or nil
    assert(network and gma.gettime() <= network.expires, 'Network request expired or mismatched')
    network.expires = gma.gettime() + 120
    if action == 'chunk' then
      assert(not network.done and a == #network.chunks + 1, 'Invalid chunk order')
      assert(type(b) == 'string' and #b > 0 and #b <= 512 and #b % 2 == 0 and not b:find('[^a-f0-9]'), 'Invalid chunk')
      local data = b:gsub('..', raw_bytes)
      assert(network.bytes + #data <= network.size, 'Payload exceeds declared size')
      network.chunks[#network.chunks + 1] = data; network.bytes = network.bytes + #data
      return 'ACK'
    end
    if action == 'run' then
      if network.input then
        local data = assert(read(network.input), 'Local request unavailable')
        assert(#data == network.size, 'Local request length mismatch')
        assert(os.remove(network.input), 'Could not remove local request'); network.input = nil
        network.chunks = {data}; network.bytes = #data
      end
      assert(not network.done and network.bytes == network.size, 'Incomplete or already executed request')
      network.done = true
      local body = table.concat(network.chunks); network.chunks = nil
      if network.delta_base then body = expand_delta(network.delta_base, body, network.desired_size); network.delta_base = nil end
      if network.base then body = #network.base .. '\n' .. network.base .. body; network.base = nil end
      local previous = b == 'checked' and snapshot_cache and snapshot_cache.target == network.target and snapshot_cache.xml
      network.job = start(id .. '\n' .. network.op .. '\n' .. network.target .. '\n' .. #body .. '\n' .. body, previous)
      -- With 'steps' the first step runs now and the program sends 'step' for each next one.
      -- Without it (an older program, or the bridge upgrade check) every step runs now, as before.
      if a == 'steps' then
        network.inline = (b == 'inline' or b == 'checked') and (network.op == 'READ' or network.op == 'SEQCUES' or network.op == 'LIST' or network.op == 'LISTSEQ' or network.op == 'TCRANGES' or network.op == 'FIRSTCUES' or network.op == 'ASSIGNSEQ'
          or network.op == 'SNAPSHOT' or network.op == 'SCOPE' or network.op == 'SYNC' or network.op == 'SEQGO')
        return proceed(network, token)
      end
      repeat advance(network.job) until network.job.response
      return finished(network)
    end
    if action == 'step' then
      assert(network.done and network.job and not network.response, 'No step pending')
      return proceed(network, token)
    end
    if action == 'readbatch' then
      assert(network.done and network.response, 'No response available')
      assert(type(a) == 'number' and a >= 0 and a < #network.response and a == math.floor(a), 'Invalid response offset')
      assert(type(b) == 'number' and b >= 1 and b <= 32 and b == math.floor(b) and a + (b - 1) * 256 < #network.response, 'Invalid response batch')
      local prefix = 'TBLINK_RPC_' .. token:sub(1, 28)
      for index = 0, b - 1 do
        local offset = a + index * 256
        gma.echo(prefix .. string.format('%04x', index) .. ':DATA:' .. hex(network.response:sub(offset + 1, offset + 256)))
      end
      return 'BATCH'
    end
    if action == 'read' then
      assert(network.done and network.response, 'No response available')
      assert(type(a) == 'number' and a >= 0 and a < #network.response and a == math.floor(a), 'Invalid response offset')
      return 'DATA:' .. hex(network.response:sub(a + 1, a + 256))
    end
    -- Releases this request's lane only; the other lane's request goes on.
    if action == 'release' then clear_transfer(network); lanes[lanes.bg == network and 'bg' or 'fg'] = nil; return 'ACK' end
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
  if key.momentary and not key.expired and gma.show.getvar('SHOWFILE') == key.show and gma.show.getobj.handle(key.address) == key.handle then
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
-- No permanent timer in network mode. Only a held Flash/Temp/Swop needs a
-- watchdog; each tick finishes and schedules another only while a key is held.
-- Invalidated generations release their keys on the last tick, then disappear
-- from the console's running-plugin list instead of leaving an infinite task.
local key_timer_pending = false
local function watch_executor_keys()
  if key_timer_pending then return end
  for _,key in pairs(executor_keys) do
    if key.momentary and not key.expired then
      key_timer_pending = true
      gma.timer(function()
        key_timer_pending = false
        expire_executor_keys()
        watch_executor_keys()
      end, 0.25, 1)
      return
    end
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
    expire_executor_keys()
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
    watch_executor_keys()
    return 'SENT'
  end)
  local response=ok and result or 'ERR:'..hex(tostring(result))
  gma.echo('TBLINK_EXEC_'..token..':'..response)
  return response
end
local poll_pending = false
local function watch_request_file()
  if poll_pending or not active or _G.TBLINK_BRIDGE_GENERATION ~= generation then return end
  poll_pending = true
  gma.timer(function()
    poll_pending = false
    if not active or _G.TBLINK_BRIDGE_GENERATION ~= generation then return end
    poll()
    watch_request_file()
  end, 0.1, 1)
end
local function main(mode)
  if active then
    active = false
    expire_executor_keys()
    for number, ref in pairs(snapshot_files) do discard(ref.name); snapshot_files[number] = nil end
    if _G.TBLINK_BRIDGE_GENERATION == generation then _G.TBLINK_BRIDGE_READY = false end
    gma.feedback('TBLINK bridge stopped'); return
  end
  if mode == 'network' then
    active = true
    _G.TBLINK_BRIDGE_READY = true
    return
  end
  -- A restart must not replay a previously sent write with an uncertain outcome.
  os.rename(request_file, root .. '/temp/tblink_bridge_abandoned_' .. generation .. '.txt')
  active = true
  _G.TBLINK_BRIDGE_READY = true
  watch_request_file()
  gma.feedback('TBLINK local onPC bridge ready')
end
return main
