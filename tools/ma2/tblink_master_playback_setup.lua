-- Owned, empty-sequence test rig for observing sparse native Master events.
-- Refuse every occupied destination before creating any object. No playback starts here.
local obj = gma.show.getobj
for _, address in ipairs({'Sequence 9904', 'Executor 99.1', 'Timecode 9904'}) do
  assert(not obj.handle(address), address .. ' already exists; refusing to overwrite')
end
local root = gma.show.getvar('PATH')
local function write(name, body)
  local file = assert(io.open(root .. '/importexport/' .. name .. '.xml', 'wb'))
  assert(file:write(body)); assert(file:close())
end
local header = '<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="3" stream_vers="4">'
write('tblink_master_probe_sequence', header .. [[
<Sequ index="9903" name="TBLINK_MASTER_INTERPOLATION">
<Cue index="1"><Number number="1"/><CuePart index="0"/></Cue>
</Sequ></MA>]])
gma.cmd('Import "tblink_master_probe_sequence.xml" At Sequence 9904 /nc')
assert(obj.label(assert(obj.handle('Sequence 9904'))) == 'TBLINK_MASTER_INTERPOLATION', 'Sequence ownership failed')
gma.cmd('Assign Sequence 9904 At Executor 99.1 /nc')
assert(obj.handle('Executor 99.1'), 'Executor assignment failed')
write('tblink_master_probe_timecode', header .. [[
<Timecode index="9903" name="TBLINK_MASTER_INTERPOLATION" slot="TC Slot 1" frame_format="30 FPS">
<Track index="0" active="true" expanded="true">
<Object><No>30</No><No>1</No><No>99</No><No>1</No></Object>
<SubTrack index="0"/>
<SubTrack index="1" fader_command="Master">
<Event index="0" fader_level="0.2"/>
<Event index="1" time="300" fader_level="0.8"/>
<Event index="2" time="600" fader_level="0.8"/>
</SubTrack></Track></Timecode></MA>]])
gma.cmd('Import "tblink_master_probe_timecode.xml" At Timecode 9904 /nc')
assert(obj.label(assert(obj.handle('Timecode 9904'))) == 'TBLINK_MASTER_INTERPOLATION', 'Timecode ownership failed')
gma.cmd('Assign Timecode 9904 /Slot=-1')
gma.cmd('Assign Timecode 9904 /Length=21')
gma.cmd('Export Timecode 9904 "tblink_master_probe_ready" /o')
gma.cmd('Export Executor 99.1 "tblink_master_probe_executor" /o')
gma.feedback('TBLINK Master rig ready; no playback started')
