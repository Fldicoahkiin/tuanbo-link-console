-- Start only the dedicated empty-sequence Timecode, then pause for visual inspection.
return function(seconds)
  assert(seconds == 2 or seconds == 5 or seconds == 11, 'Only planned sample positions are allowed')
  local obj = gma.show.getobj
  assert(obj.label(assert(obj.handle('Timecode 9904'))) == 'TBLINK_MASTER_INTERPOLATION', 'Unexpected Timecode')
  assert(obj.label(assert(obj.handle('Sequence 9904'))) == 'TBLINK_MASTER_INTERPOLATION', 'Unexpected sequence')
  assert(obj.label(assert(obj.handle('Executor 99.1'))) == 'TBLINK_MASTER_INTERPOLATION', 'Unexpected executor')
  gma.cmd('Off Timecode 9904')
  gma.cmd('Export Timecode 9904 "tblink_master_before_sample" /o')
  gma.cmd('Top Timecode 9904')
  gma.cmd('Go Timecode 9904')
  local started, calls = gma.gettime(), 0
  -- Native 3.3.4 invokes the first callback immediately, then waits dt.
  gma.timer(function()
    calls = calls + 1
    if calls == 2 then
      gma.cmd('Pause Timecode 9904')
      gma.export_json('tblink_master_pause_' .. seconds .. '.json', {elapsed = gma.gettime() - started, requested = seconds})
      gma.cmd('Edit Timecode 9904')
    end
  end, seconds, 2)
end
