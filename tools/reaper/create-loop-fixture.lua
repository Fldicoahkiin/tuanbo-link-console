-- Run once in the saved, owned ramp fixture; never starts playback.
local p, filename = reaper.EnumProjects(-1, '')
assert(filename:match('reaper%-native%-ramp%-6%.05%.rpp$') and reaper.CountTracks(p) == 7, 'Open the saved TBLINK ramp fixture')
local output = filename:gsub('reaper%-native%-ramp%-6%.05%.rpp$', 'reaper-native-loop-6.05.expected.json')
local existing = io.open(output, 'r')
if existing then existing:close(); error('Expected loop report already exists') end
local cases = {
  {'loop-normal', 0, 1, true}, {'loop-offset-double', 0.5, 2, true},
  {'loop-late-offset', 1.5, 1, true}, {'origin-before-zero', 3, 1, false},
  {'origin-before-zero-double', 6, 2, false}, {'loop-before-zero', 3, 1, true}
}
local report = {}
reaper.Undo_BeginBlock2(p)
for _, case in ipairs(cases) do
  local index = reaper.CountTracks(p)
  reaper.InsertTrackAtIndex(index, false)
  local track = reaper.GetTrack(p, index)
  reaper.GetSetMediaTrackInfo_String(track, 'P_NAME', case[1], true)
  reaper.SetMediaTrackInfo_Value(track, 'B_MUTE', 1)
  local qn = reaper.TimeMap2_timeToQN(p, 2)
  local sourceBeats = case[4] and 1 or 12
  local item = reaper.CreateNewMIDIItemInProj(track, qn, qn + sourceBeats, true)
  local take = reaper.GetActiveTake(item)
  local ppq0 = reaper.MIDI_GetPPQPosFromProjQN(take, qn)
  local ppq1 = reaper.MIDI_GetPPQPosFromProjQN(take, qn + 1)
  local ppq = ppq1 - ppq0
  for n = 0, (case[4] and 1 or 10) do
    local beat = case[4] and n * 0.5 or n
    assert(reaper.MIDI_InsertNote(take, false, false, ppq0 + beat * ppq, ppq0 + (beat + 0.25) * ppq, 0, 60 + n, 100, false))
  end
  reaper.SetMediaItemInfo_Value(item, 'B_LOOPSRC', case[4] and 1 or 0)
  reaper.SetMediaItemInfo_Value(item, 'D_LENGTH', 6.7)
  assert(reaper.SetMediaItemTakeInfo_Value(take, 'D_STARTOFFS', case[2]))
  assert(reaper.SetMediaItemTakeInfo_Value(take, 'D_PLAYRATE', case[3]))
  local period, isQN = reaper.GetMediaSourceLength(reaper.GetMediaItemTake_Source(take))
  assert(isQN, 'Expected native beat-based source length')
  local _, count = reaper.MIDI_CountEvts(take)
  local notes = {}
  for repetition = 0, (case[4] and 63 or 0) do
    for noteIndex = 0, count - 1 do
      local ok, _, _, first, last, _, pitch = reaper.MIDI_GetNote(take, noteIndex)
      assert(ok)
      local startTime = reaper.MIDI_GetProjTimeFromPPQPos(take, first + repetition * period * ppq)
      local endTime = reaper.MIDI_GetProjTimeFromPPQPos(take, last + repetition * period * ppq)
      if endTime > 2 and startTime < 8.7 then
        notes[#notes + 1] = string.format('{"note":%d,"startMs":%.12f,"endMs":%.12f}', pitch, math.max(2, startTime) * 1000, math.min(8.7, endTime) * 1000)
      end
    end
  end
  report[#report + 1] = string.format('{"name":"%s","sourceBeats":%.12f,"notes":[%s]}', case[1], period, table.concat(notes, ','))
end
reaper.TrackList_AdjustWindows(false)
reaper.UpdateArrange()
reaper.Undo_EndBlock2(p, 'Create TBLINK native loop fixtures', -1)
local file = assert(io.open(output, 'w'))
file:write('{"reaperVersion":"' .. reaper.GetAppVersion() .. '","tracks":[' .. table.concat(report, ',') .. ']}')
file:close()
-- Save As reaper-native-loop-6.05.rpp beside the baseline fixtures.
