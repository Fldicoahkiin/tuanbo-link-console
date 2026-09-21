-- Explicitly invoked local acceptance on the existing, owned empty-sequence rig.
-- Keep a native backup and restore the Timecode after the supervised run.
return function(action)
  local obj = gma.show.getobj
  for _, address in ipairs({'Timecode 9904', 'Sequence 9904', 'Executor 99.1'}) do
    assert(obj.label(assert(obj.handle(address))) == 'TBLINK_MASTER_INTERPOLATION', 'Unexpected test object: ' .. address)
  end
  local backup = 'tblink_mtc_acceptance_20260915_before'
  if action == 'arm' then
    assert(not TBLINK_MTC_ACCEPTANCE_ACTIVE, 'Acceptance already armed')
    gma.cmd('Off Timecode 9904')
    gma.cmd('Export Timecode 9904 "' .. backup .. '" /o')
    local file = assert(io.open(gma.show.getvar('PATH') .. '/importexport/' .. backup .. '.xml', 'rb'))
    local xml = assert(file:read('*a')); assert(file:close())
    assert(xml:find('TBLINK_MASTER_INTERPOLATION', 1, true), 'Backup ownership missing')
    TBLINK_MTC_ACCEPTANCE_ACTIVE = true
    gma.cmd('Assign Timecode 9904 /Slot=2')
    gma.cmd('Go Timecode 9904')
    gma.cmd('Export Timecode 9904 "tblink_mtc_acceptance_20260915_armed" /o')
    gma.feedback('TBLINK dedicated Timecode armed for MIDI Slot 2')
  elseif action == 'restore' then
    assert(TBLINK_MTC_ACCEPTANCE_ACTIVE, 'No active acceptance backup')
    gma.cmd('Off Timecode 9904')
    gma.cmd('Off Executor 99.1')
    gma.cmd('Import "' .. backup .. '.xml" At Timecode 9904 /nc')
    gma.cmd('Export Timecode 9904 "tblink_mtc_acceptance_20260915_restored" /o')
    TBLINK_MTC_ACCEPTANCE_ACTIVE = nil
    gma.feedback('TBLINK dedicated Timecode restored; verify exported XML')
  else
    error('Expected arm or restore')
  end
end
