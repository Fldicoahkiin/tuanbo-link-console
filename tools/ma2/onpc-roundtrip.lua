local handle = gma.show.getobj.handle("Timecode 9901")
if not handle then error("Acceptance object missing") end
local label = gma.show.getobj.label(handle) or gma.show.getobj.name(handle)
if label ~= "TBLINK_ONPC_ACCEPTANCE" then error("Target is not the owned acceptance object") end
gma.cmd('Export Timecode 9901 "tblink_onpc_before.xml" /o')
gma.cmd('Import "tblink_onpc_events.xml" At Timecode 9901 /o /nc')
gma.cmd('Export Timecode 9901 "tblink_onpc_readback.xml" /o')
gma.feedback("TBLINK roundtrip requested; verify exported XML")
