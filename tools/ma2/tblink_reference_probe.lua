-- Read-only inspection of the dedicated acceptance Timecode and its sample
-- sequence references. No playback, store, import or show modification.
local obj = gma.show.getobj
local property = gma.show.property
local root = gma.show.getvar('PATH')
local tc = assert(obj.handle('Timecode 9901'), 'Acceptance Timecode missing')
assert((obj.label(tc) or obj.name(tc)) == 'TBLINK_ONPC_ACCEPTANCE', 'Unexpected Timecode owner')
local lines = { 'path\tclass\tindex\tnumber\tname\tlabel\tchildren' }
local function field(value) local result = tostring(value):gsub('[\r\n\t]', ' '); return result end
local count = 0
local function visit(handle, path, depth)
  if not handle then lines[#lines + 1] = path .. '\tMISSING'; return end
  count = count + 1
  assert(count <= 2000 and depth <= 8, 'Reference probe bounds exceeded')
  local children = obj.amount(handle)
  lines[#lines + 1] = table.concat({path, field(obj.class(handle)), field(obj.index(handle)), field(obj.number(handle)), field(obj.name(handle)), field(obj.label(handle)), field(children)}, '\t')
  for i = 0, property.amount(handle) - 1 do
    lines[#lines + 1] = path .. '\tPROPERTY\t' .. field(property.name(handle, i)) .. '\t' .. field(property.get(handle, i))
  end
  for i = 0, children - 1 do visit(obj.child(handle, i), path .. '/' .. i, depth + 1) end
end
visit(tc, 'Timecode 9901', 0)
-- XML No 9004 may be an internal index. Inspect both neighbouring numbers,
-- without assuming either is the actual command-line sequence number.
visit(obj.handle('Sequence 9004'), 'Sequence 9004', 0)
visit(obj.handle('Sequence 9005'), 'Sequence 9005', 0)
local file = assert(io.open(root .. '/temp/tblink_reference_probe.tsv', 'wb'))
assert(file:write(table.concat(lines, '\n')))
assert(file:close())
gma.feedback('TBLINK reference probe complete')
