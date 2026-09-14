-- Create dedicated non-playing objects for fractional Cue reference checks.
-- Refuse to overwrite an existing sequence or executor.
local obj = gma.show.getobj
assert(not obj.handle('Sequence 9901'), 'Sequence 9901 already exists')
assert(not obj.handle('Executor 99.219'), 'Executor 99.219 already exists')
gma.cmd('Store Sequence 9901 Cue 1.250 /nc')
local sequence = assert(obj.handle('Sequence 9901'), 'Sequence creation failed')
gma.cmd('Label Sequence 9901 "TBLINK_CUE_REFERENCE_ACCEPTANCE"')
assert(obj.label(sequence) == 'TBLINK_CUE_REFERENCE_ACCEPTANCE', 'Sequence ownership not confirmed')
gma.cmd('Store Sequence 9901 Cue 7.500 /nc')
gma.cmd('Assign Sequence 9901 At Executor 99.219 /nc')
gma.cmd('Export Sequence 9901 "tblink_fractional_sequence" /o')
gma.cmd('Export Executor 99.219 "tblink_fractional_executor" /o')
local root = gma.show.getvar('PATH')
local file = assert(io.open(root .. '/temp/tblink_fractional_references.tsv', 'wb'))
for i = 0, obj.amount(sequence) - 1 do
  local child = obj.child(sequence, i)
  if child then assert(file:write(tostring(obj.class(child)), '\t', tostring(obj.index(child)), '\t', tostring(obj.number(child)), '\t', tostring(obj.name(child)), '\n')) end
end
assert(file:close())
gma.feedback('TBLINK fractional Cue references exported; no playback started')
