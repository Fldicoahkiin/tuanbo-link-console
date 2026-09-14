-- Read-only probe for the owned onPC acceptance executor. No playback or writes to Show objects.
local obj, property = gma.show.getobj, gma.show.property
local executor = assert(obj.handle('Executor 99.219'), 'Acceptance executor missing')
assert((obj.label(executor) or obj.name(executor)) == 'TBLINK_CUE_REFERENCE_ACCEPTANCE', 'Unexpected executor owner')
local rows, seen = { 'path\tclass\tname\tproperty\tvalue' }, {}
local function field(value) return tostring(value):gsub('[\r\n\t]', ' ') end
local count = 0
local function visit(handle, path, depth)
  if not handle then rows[#rows + 1] = path .. '\tMISSING'; return end
  if seen[handle] then rows[#rows + 1] = path .. '\tALIAS\t' .. seen[handle]; return end
  seen[handle] = path
  count = count + 1
  assert(count <= 100 and depth <= 4, 'Probe bounds exceeded')
  local prefix = path .. '\t' .. field(obj.class(handle)) .. '\t' .. field(obj.name(handle))
  rows[#rows + 1] = prefix .. '\tchildren\t' .. field(obj.amount(handle))
  for index = 0, property.amount(handle) - 1 do
    rows[#rows + 1] = prefix .. '\t' .. field(property.name(handle, index)) .. '\t' .. field(property.get(handle, index))
  end
  if depth < 4 then
    for index = 0, obj.amount(handle) - 1 do visit(obj.child(handle, index), path .. '/' .. index, depth + 1) end
  end
end
visit(executor, 'Executor 99.219', 0)
visit(obj.handle('Fader 99.219'), 'Fader 99.219', 0)
local file = assert(io.open(gma.show.getvar('PATH') .. '/temp/tblink_executor_state_probe.tsv', 'wb'))
assert(file:write(table.concat(rows, '\n')))
assert(file:close())
gma.feedback('TBLINK executor state probe complete')
