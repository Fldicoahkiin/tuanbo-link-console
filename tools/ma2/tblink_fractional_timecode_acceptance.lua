-- Dedicated reference roundtrip; no playback and no existing Timecode is overwritten.
local obj = gma.show.getobj
assert(not obj.handle('Timecode 9902'), 'Timecode 9902 already exists')
local sequence = assert(obj.handle('Sequence 9901'), 'Fractional test sequence missing')
assert(obj.label(sequence) == 'TBLINK_CUE_REFERENCE_ACCEPTANCE', 'Unexpected sequence owner')
assert(obj.handle('Executor 99.219'), 'Fractional test executor missing')
local root = gma.show.getvar('PATH')
local xml = [[<?xml version="1.0" encoding="utf-8"?>
<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="3" stream_vers="4">
<Timecode index="9901" name="TBLINK_FRACTIONAL_TIMECODE" slot="TC Slot 1" frame_format="30 FPS">
<Track index="0" active="true" expanded="true"><Object><No>30</No><No>1</No><No>99</No><No>219</No></Object>
<SubTrack index="0"><Event index="0" command="Goto" pressed="true" step="1"><Cue><No>1</No><No>9901</No><No>1</No></Cue></Event>
<Event index="1" time="45" command="Goto" pressed="true" step="1"><Cue><No>1</No><No>9901</No><No>2</No></Cue></Event></SubTrack></Track>
</Timecode></MA>]]
local input = assert(io.open(root .. '/importexport/tblink_fractional_timecode_input.xml', 'wb'))
assert(input:write(xml)); assert(input:close())
gma.cmd('Import "tblink_fractional_timecode_input.xml" At Timecode 9902 /nc')
local tc = assert(obj.handle('Timecode 9902'), 'Timecode import failed')
assert(obj.label(tc) == 'TBLINK_FRACTIONAL_TIMECODE', 'Unexpected imported object')
gma.cmd('Export Timecode 9902 "tblink_fractional_timecode_readback" /o')
local file = assert(io.open(root .. '/temp/tblink_fractional_timecode_properties.tsv', 'wb'))
local track = assert(obj.child(tc, 0)); local subtrack = assert(obj.child(track, 0))
for i = 0, obj.amount(subtrack) - 1 do
  local event = assert(obj.child(subtrack, i))
  for j = 0, gma.show.property.amount(event) - 1 do
    assert(file:write(tostring(i), '\t', tostring(gma.show.property.name(event, j)), '\t', tostring(gma.show.property.get(event, j)), '\n'))
  end
end
assert(file:close())
gma.feedback('TBLINK fractional Timecode imported and read back; no playback')
