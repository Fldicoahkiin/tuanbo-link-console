-- Native, muted multi-take fixtures. Run once on the owned message project.
local p, filename = reaper.EnumProjects(-1, '')
assert(filename:match('reaper%-native%-messages%-6%.05%.rpp$'), 'Open the saved TBLINK message fixture')
local count = reaper.CountTracks(p)
assert(count == 14 or count == 15, 'Unexpected track count')
if count == 15 then
  local _, name = reaper.GetSetMediaTrackInfo_String(reaper.GetTrack(p, 14), 'P_NAME', '', false)
  assert(name == 'native-takes-1', 'Only resume our partial first fixture')
end
local _, script = reaper.get_action_context()
local sourcePath = script:match('^(.*[\\/])') .. 'take-source.mid'
assert(reaper.AddTakeToMediaItem and reaper.PCM_Source_CreateFromType and reaper.SetMediaItemTake_Source)
reaper.Undo_BeginBlock2(p)
for case = 1, 3 do
  local index = case + 13
  if reaper.CountTracks(p) <= index then reaper.InsertTrackAtIndex(index, false) end
  local track = reaper.GetTrack(p, index)
  reaper.GetSetMediaTrackInfo_String(track, 'P_NAME', 'native-takes-' .. case, true)
  reaper.SetMediaTrackInfo_Value(track, 'B_MUTE', 1)
  local item = reaper.GetTrackMediaItem(track, 0) or reaper.CreateNewMIDIItemInProj(track, 2, 8, false)
  reaper.SetMediaItemInfo_Value(item, 'B_LOOPSRC', 0)
  local takes = { reaper.GetActiveTake(item) }
  for k = 2, 3 do
    local take = reaper.GetTake(item, k - 1) or reaper.AddTakeToMediaItem(item)
    takes[k] = take
  end
  for k, take in ipairs(takes) do
    local source = reaper.PCM_Source_CreateFromFileEx(sourcePath, false)
    assert(source and reaper.SetMediaItemTake_Source(take, source), 'Initialize native MIDI take')
    reaper.GetSetMediaItemTakeInfo_String(take, 'P_NAME', 'Version ' .. k, true)
    reaper.SetMediaItemTakeInfo_Value(take, 'D_PLAYRATE', k == 2 and 2 or 1)
    reaper.SetMediaItemTakeInfo_Value(take, 'D_STARTOFFS', k == 2 and 0.5 or 0)
    local at = reaper.MIDI_GetPPQPosFromProjTime(take, 3 + k * 0.5)
    local ending = reaper.MIDI_GetPPQPosFromProjTime(take, 3.25 + k * 0.5)
    assert(reaper.MIDI_SetNote(take, 0, false, false, at, ending, 0, 60 + k, 90 + k, false))
    reaper.MIDI_Sort(take)
  end
  reaper.SetActiveTake(takes[case == 3 and 2 or case])
  reaper.SetMediaItemInfo_Value(item, 'B_ALLTAKESPLAY', case == 3 and 1 or 0)
end
reaper.TrackList_AdjustWindows(false)
reaper.UpdateArrange()
reaper.Undo_EndBlock2(p, 'Create TBLINK native multi-takes', -1)
-- Save As reaper-native-takes-6.05.rpp; no playback or external output.
