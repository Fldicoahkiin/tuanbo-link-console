-- Run once in the owned, saved baseline fixture. No playback or MIDI outputs.
local p, filename = reaper.EnumProjects(-1, '')
assert(filename:match('reaper%-native%-6%.05%.rpp$') and reaper.CountTracks(p) == 1, 'Open the saved TBLINK baseline fixture')
local _, trackName = reaper.GetTrackName(reaper.GetTrack(p, 0), '')
assert(trackName == 'TBLINK muted solo sample', 'Unexpected baseline track')
local output = filename:gsub('reaper%-native%-6%.05%.rpp$', 'reaper-native-ramp-6.05.expected.json')
local existing = io.open(output, 'r')
if existing then existing:close(); error('Expected timing report already exists') end
reaper.Undo_BeginBlock2(p)
assert(reaper.SetTempoTimeSigMarker(p, 0, 0, -1, -1, 60, 3, 4, true))
assert(reaper.SetTempoTimeSigMarker(p, -1, 4, -1, -1, 180, 3, 4, false))
local cases = {
  {'ramp-normal', 0, 1}, {'ramp-offset', 0.5, 1},
  {'ramp-double', 0, 2}, {'ramp-offset-double', 0.5, 2},
  {'ramp-half', 0, 0.5}, {'ramp-negative-offset', -0.5, 1}
}
local report = {}
for _, case in ipairs(cases) do
  local index = reaper.CountTracks(p)
  reaper.InsertTrackAtIndex(index, false)
  local track = reaper.GetTrack(p, index)
  reaper.GetSetMediaTrackInfo_String(track, 'P_NAME', case[1], true)
  reaper.SetMediaTrackInfo_Value(track, 'B_MUTE', 1)
  local item = reaper.CreateNewMIDIItemInProj(track, 2, 10, false)
  reaper.SetMediaItemInfo_Value(item, 'B_LOOPSRC', 0)
  local take = reaper.GetActiveTake(item)
  local startQN = reaper.TimeMap2_timeToQN(p, 2)
  for note = 0, 2 do
    local startPPQ = reaper.MIDI_GetPPQPosFromProjQN(take, startQN + note * 2)
    local endPPQ = reaper.MIDI_GetPPQPosFromProjQN(take, startQN + note * 2 + 1)
    assert(reaper.MIDI_InsertNote(take, false, false, startPPQ, endPPQ, 0, 60 + note, 100, false))
  end
  assert(reaper.SetMediaItemTakeInfo_Value(take, 'D_STARTOFFS', case[2]))
  assert(reaper.SetMediaItemTakeInfo_Value(take, 'D_PLAYRATE', case[3]))
  local _, count = reaper.MIDI_CountEvts(take)
  local notes = {}
  for indexNote = 0, count - 1 do
    local ok, _, _, first, last, _, pitch = reaper.MIDI_GetNote(take, indexNote)
    assert(ok)
    local startTime = reaper.MIDI_GetProjTimeFromPPQPos(take, first)
    local endTime = reaper.MIDI_GetProjTimeFromPPQPos(take, last)
    notes[#notes + 1] = string.format('{"note":%d,"startMs":%.12f,"endMs":%.12f}', pitch, startTime * 1000, endTime * 1000)
  end
  report[#report + 1] = '{"name":"' .. case[1] .. '","notes":[' .. table.concat(notes, ',') .. ']}'
end
reaper.TrackList_AdjustWindows(false)
reaper.UpdateArrange()
reaper.Undo_EndBlock2(p, 'Create TBLINK native tempo fixtures', -1)
local file = assert(io.open(output, 'w'))
file:write('{"reaperVersion":"' .. reaper.GetAppVersion() .. '","tracks":[' .. table.concat(report, ',') .. ']}')
file:close()
-- Save As reaper-native-ramp-6.05.rpp in the same fixture directory using REAPER.
