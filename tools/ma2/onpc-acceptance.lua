-- Creates an isolated, non-playing Timecode object for the authorized onPC test.
local target = 9901
if gma.show.getobj.handle("Timecode " .. target) then
    error("Timecode 9901 already exists; refusing to overwrite")
end
gma.cmd("Store Timecode " .. target .. " /nc")
gma.cmd('Label Timecode ' .. target .. ' "TBLINK_ONPC_ACCEPTANCE"')
gma.cmd('Export Timecode ' .. target .. ' "tblink_onpc_acceptance.xml" /o')
gma.feedback("TBLINK acceptance object created; no playback started")
