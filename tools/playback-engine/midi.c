#include "engine.h"
#include <avrt.h>
#include <string.h>

/* Cancels a requested or running reopen. A running one owns the handle and header until WinMM
 * returns (about 3 s while Windows is still creating a port): wait for it, at most 4 s.
 * Caller holds midi_lock; it is held again on return. */
static MMRESULT midi_cancel_reopen(void) {
  engine.reopen_requested = FALSE; engine.reopen_ticket++;
  for (int waited = 0; engine.reopen_running && waited < 400; waited++) {
    LeaveCriticalSection(&engine.midi_lock); Sleep(10); EnterCriticalSection(&engine.midi_lock);
  }
  return engine.reopen_running ? (MMRESULT)ERROR_BUSY : MMSYSERR_NOERROR;
}
MMRESULT midi_release(void) {
  EnterCriticalSection(&engine.midi_lock);
  MMRESULT result = midi_cancel_reopen();
  if (result != MMSYSERR_NOERROR) engine.midi_error = (int32_t)result;
  else if (engine.midi) {
    result = midiOutReset(engine.midi);
    if (result == MMSYSERR_NOERROR && (engine.midi_header.dwFlags & MHDR_PREPARED)) result = midiOutUnprepareHeader(engine.midi, &engine.midi_header, sizeof(MIDIHDR));
    if (result == MMSYSERR_NOERROR) result = midiOutClose(engine.midi);
    /* An unplugged port (MMSYSERR_NODRIVER, or an already invalid handle) can be neither
     * reset nor closed and its handle is dead. Forget it, so the port opens again once it is back. */
    if (result == MMSYSERR_NODRIVER || result == MMSYSERR_INVALHANDLE) { (void)midiOutClose(engine.midi); result = MMSYSERR_NOERROR; }
    if (result == MMSYSERR_NOERROR) engine.midi = NULL;
    else engine.midi_error = (int32_t)result;
  }
  LeaveCriticalSection(&engine.midi_lock); return result;
}
/* Opens the timecode port by its index in the device list the host read moments ago. The opened
 * handle must carry the chosen name: a port added or removed in between moves the indexes, and the
 * timecode must never go to another interface. */
MMRESULT midi_prepare(UINT device, UINT fps, BOOL drop_frame, BOOL quarter_frames_only, const wchar_t *name) {
  MMRESULT released = midi_release();
  if (released != MMSYSERR_NOERROR) return released;
  EnterCriticalSection(&engine.midi_lock);
  engine.fps = fps; engine.drop_frame = drop_frame; engine.quarter_frames_only = quarter_frames_only;
  engine.midi_error = 0; engine.midi_sent = 0; engine.max_late = 0;
  engine.midi_interruptions = 0; engine.midi_interruption = 0; engine.midi_transient = 0; engine.midi_transient_code = 0;
  engine.midi_wake_gap_ms = engine.midi_lock_wait_ms = engine.midi_audio_lock_wait_ms = engine.midi_send_ms = 0;
  MMRESULT result = MMSYSERR_NOERROR;
  if (device != 0xffffffffu) {
    if (engine.midi_worker_error) result = MMSYSERR_ERROR;
    else if (device >= midiOutGetNumDevs()) result = MMSYSERR_BADDEVICEID;
    else result = midiOutOpen(&engine.midi, device, 0, 0, CALLBACK_NULL);
    if (result == MMSYSERR_NOERROR) {
      MIDIOUTCAPSW actual;
      result = midiOutGetDevCapsW((UINT_PTR)engine.midi, &actual, sizeof(actual));
      if (result == MMSYSERR_NOERROR && wcscmp(name, actual.szPname) != 0) result = MMSYSERR_BADDEVICEID;
      if (result != MMSYSERR_NOERROR) { (void)midiOutClose(engine.midi); engine.midi = NULL; }
    }
    if (result == MMSYSERR_NOERROR) {
      memset(&engine.midi_header, 0, sizeof(MIDIHDR));
      engine.midi_header.lpData = (LPSTR)engine.full_frame; engine.midi_header.dwBufferLength = 10;
      result = midiOutPrepareHeader(engine.midi, &engine.midi_header, sizeof(MIDIHDR));
    }
  }
  engine.midi_error = device != 0xffffffffu && engine.midi_worker_error ? engine.midi_worker_error : (int32_t)result;
  LeaveCriticalSection(&engine.midi_lock); return result;
}
/* The same timecode port is back (authorised 2026-10-24). Only records the request; the MIDI worker
 * opens it. The outcome reaches the host through telemetry (midiReopens, midiReopenResult). */
HRESULT midi_request_reopen(UINT device, const wchar_t *name) {
  EnterCriticalSection(&engine.midi_lock);
  HRESULT result = engine.midi_worker_error ? E_FAIL : engine.reopen_requested || engine.reopen_running ? HRESULT_FROM_WIN32(ERROR_BUSY) : S_OK;
  if (result == S_OK) {
    engine.reopen_device = device; memcpy(engine.reopen_name, name, (wcslen(name) + 1) * sizeof(wchar_t));
    engine.reopen_requested = TRUE; engine.reopen_ticket++;
  }
  LeaveCriticalSection(&engine.midi_lock); return result;
}
/* Runs on the MIDI worker: entered with midi_lock held, returns with it released. The old handle is
 * dead (its port was unplugged) and is forgotten whatever its teardown returns. The opened handle must
 * carry the expected name, so an index that moved never sends elsewhere. The song's counters are kept;
 * the worker then relocates with a Full Frame at the current audio position and nothing missed is sent. */
static void midi_reopen_run(void) {
  UINT device = engine.reopen_device; UINT32 ticket = engine.reopen_ticket; wchar_t name[32];
  memcpy(name, engine.reopen_name, sizeof(name));
  HMIDIOUT old = engine.midi, opened = NULL; engine.midi = NULL;
  engine.reopen_requested = FALSE; engine.reopen_running = TRUE;
  LeaveCriticalSection(&engine.midi_lock);
  if (old) {
    (void)midiOutReset(old);
    if (engine.midi_header.dwFlags & MHDR_PREPARED) (void)midiOutUnprepareHeader(old, &engine.midi_header, sizeof(MIDIHDR));
    (void)midiOutClose(old);
  }
  MMRESULT result = device >= midiOutGetNumDevs() ? MMSYSERR_BADDEVICEID : midiOutOpen(&opened, device, 0, 0, CALLBACK_NULL);
  if (result == MMSYSERR_NOERROR) {
    MIDIOUTCAPSW actual;
    result = midiOutGetDevCapsW((UINT_PTR)opened, &actual, sizeof(actual));
    if (result == MMSYSERR_NOERROR && wcscmp(name, actual.szPname) != 0) result = MMSYSERR_BADDEVICEID;
    if (result == MMSYSERR_NOERROR) {
      memset(&engine.midi_header, 0, sizeof(MIDIHDR));
      engine.midi_header.lpData = (LPSTR)engine.full_frame; engine.midi_header.dwBufferLength = 10;
      result = midiOutPrepareHeader(opened, &engine.midi_header, sizeof(MIDIHDR));
    }
    if (result != MMSYSERR_NOERROR) { (void)midiOutClose(opened); opened = NULL; }
  }
  EnterCriticalSection(&engine.midi_lock);
  BOOL current = ticket == engine.reopen_ticket;
  // A failed reopen leaves the previous error in place: the port is still unusable.
  if (current && opened) { engine.midi = opened; engine.midi_error = 0; opened = NULL; }
  if (opened) {
    // Cancelled by a newer preparation meanwhile: release this handle before giving up the header.
    LeaveCriticalSection(&engine.midi_lock);
    (void)midiOutUnprepareHeader(opened, &engine.midi_header, sizeof(MIDIHDR)); (void)midiOutClose(opened);
    EnterCriticalSection(&engine.midi_lock);
  }
  engine.midi_reopen_result = current ? (int32_t)result : (int32_t)ERROR_CANCELLED; engine.midi_reopens++;
  engine.reopen_running = FALSE;
  LeaveCriticalSection(&engine.midi_lock);
}
/* A stale audio clock (-2) or a late wake-up (-1) is transient: nothing is sent
 * late, the interruption is counted once, and the next fresh clock relocates the
 * receiver with a Full Frame at the actual audio position. Caller holds midi_lock. */
static void midi_interrupt(int32_t reason, BOOL *running) {
  if (*running) { engine.midi_interruptions++; engine.midi_interruption = reason; }
  *running = FALSE;
}
/* A send Windows refused. The interface gone (5/6) stops timecode, and the port recovery of 2026-10-24 takes
 * over. Any other refusal is this send only (2026-11-10 decision 2): counted, and the next tick relocates the
 * receiver with a Full Frame at the current audio position; the host stops timecode at its limit. Caller holds midi_lock. */
static void midi_send_failed(MMRESULT code, BOOL *running) {
  if (code == MMSYSERR_INVALHANDLE || code == MMSYSERR_NODRIVER) engine.midi_error = (int32_t)code;
  else { engine.midi_transient++; engine.midi_transient_code = (int32_t)code; }
  *running = FALSE;
}
DWORD WINAPI midi_worker(void *unused) {
  (void)unused;
  DWORD task = 0; HANDLE priority = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  if (!priority || !AvSetMmThreadPriority(priority, AVRT_PRIORITY_CRITICAL)) {
    DWORD error = GetLastError();
    EnterCriticalSection(&engine.midi_lock); engine.midi_error = engine.midi_worker_error = (int32_t)(error ? error : ERROR_INVALID_FUNCTION); LeaveCriticalSection(&engine.midi_lock);
    if (priority) AvRevertMmThreadCharacteristics(priority);
    return 1;
  }
  HANDLE timer = CreateWaitableTimerExW(NULL, NULL, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS);
  if (!timer) { EnterCriticalSection(&engine.midi_lock); engine.midi_error = engine.midi_worker_error = (int32_t)GetLastError(); LeaveCriticalSection(&engine.midi_lock); if (priority) AvRevertMmThreadCharacteristics(priority); return 1; }
  LARGE_INTEGER due; due.QuadPart = -10000;
  if (!SetWaitableTimer(timer, &due, 1, NULL, NULL, FALSE)) { EnterCriticalSection(&engine.midi_lock); engine.midi_error = engine.midi_worker_error = (int32_t)GetLastError(); LeaveCriticalSection(&engine.midi_lock); CloseHandle(timer); if (priority) AvRevertMmThreadCharacteristics(priority); return 1; }
  HANDLE events[] = { engine.quit, timer };
  UINT32 generation = 0, epoch = 0, piece = 0; BOOL running = FALSE;
  LARGE_INTEGER frequency; QueryPerformanceFrequency(&frequency);
  LARGE_INTEGER previous_wake = {0};
  UINT64 quarter = 0; unsigned char time[4] = {0};
  while (WaitForMultipleObjects(2, events, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) {
    LARGE_INTEGER wake, acquired, audio_acquired; QueryPerformanceCounter(&wake);
    EnterCriticalSection(&engine.midi_lock);
    QueryPerformanceCounter(&acquired);
    if (engine.midi_suspended) { LeaveCriticalSection(&engine.midi_lock); continue; }
    if (engine.reopen_requested) { midi_reopen_run(); running = FALSE; continue; }
    EnterCriticalSection(&engine.lock);
    QueryPerformanceCounter(&audio_acquired);
    UINT32 state = engine.state, current_generation = engine.generation, current_epoch = engine.epoch;
    double position = engine.position_ms + engine.offset_ms;
    UINT64 clock_qpc = engine.clock_qpc;
    LeaveCriticalSection(&engine.lock);
    if (state != PLAYING || !engine.midi || engine.midi_error) { running = FALSE; LeaveCriticalSection(&engine.midi_lock); continue; }
    if (running) {
      engine.midi_wake_gap_ms = fmax(engine.midi_wake_gap_ms, (double)(wake.QuadPart - previous_wake.QuadPart) * 1000.0 / frequency.QuadPart);
      engine.midi_lock_wait_ms = fmax(engine.midi_lock_wait_ms, (double)(acquired.QuadPart - wake.QuadPart) * 1000.0 / frequency.QuadPart);
      engine.midi_audio_lock_wait_ms = fmax(engine.midi_audio_lock_wait_ms, (double)(audio_acquired.QuadPart - acquired.QuadPart) * 1000.0 / frequency.QuadPart);
    }
    previous_wake = wake;
    if (!clock_qpc) { LeaveCriticalSection(&engine.midi_lock); continue; }
    double frame_ms = timecode_frame_ms(engine.fps, engine.drop_frame);
    LARGE_INTEGER now; QueryPerformanceCounter(&now);
    double clock_age_ms = ((double)now.QuadPart * 10000000.0 / frequency.QuadPart - (double)clock_qpc) / 10000.0;
    if (clock_age_ms > frame_ms) { midi_interrupt(-2, &running); LeaveCriticalSection(&engine.midi_lock); continue; }
    if (!running || generation != current_generation || epoch != current_epoch) {
      // Quarter frames alone relocate the receiver too, two frames later, once it has all eight.
      if (!engine.quarter_frames_only) {
        if ((engine.midi_header.dwFlags & MHDR_INQUEUE) != 0) { LeaveCriticalSection(&engine.midi_lock); continue; }
        timecode_parts((UINT64)floor(position / frame_ms), engine.fps, engine.drop_frame, time);
        const unsigned char begin[] = { 0xf0, 0x7f, 0x7f, 1, 1 };
        memcpy(engine.full_frame, begin, 5); memcpy(engine.full_frame + 5, time, 4); engine.full_frame[9] = 0xf7;
        MMRESULT relocated = midiOutLongMsg(engine.midi, &engine.midi_header, sizeof(MIDIHDR));
        if (relocated != MMSYSERR_NOERROR) { midi_send_failed(relocated, &running); LeaveCriticalSection(&engine.midi_lock); continue; }
        engine.midi_sent++;
      }
      generation = current_generation; epoch = current_epoch; running = TRUE; piece = 0;
      quarter = (UINT64)ceil(position / frame_ms) * 4;
    }
    double late = position - (double)quarter * frame_ms / 4.0;
    if (late > engine.max_late) engine.max_late = late;
    if (late > frame_ms) { midi_interrupt(-1, &running); LeaveCriticalSection(&engine.midi_lock); continue; }
    while ((double)quarter * frame_ms / 4.0 <= position) {
      if (!piece) timecode_parts(quarter / 4, engine.fps, engine.drop_frame, time);
      unsigned char nibbles[] = { time[3] & 15, (time[3] >> 4) & 1, time[2] & 15, (time[2] >> 4) & 3,
        time[1] & 15, (time[1] >> 4) & 3, time[0] & 15, (time[0] >> 4) & 7 };
      DWORD message = 0xf1u | ((DWORD)((piece << 4) | nibbles[piece]) << 8);
      LARGE_INTEGER send_started, send_finished; QueryPerformanceCounter(&send_started);
      MMRESULT sent = midiOutShortMsg(engine.midi, message);
      QueryPerformanceCounter(&send_finished);
      engine.midi_send_ms = fmax(engine.midi_send_ms, (double)(send_finished.QuadPart - send_started.QuadPart) * 1000.0 / frequency.QuadPart);
      if (sent != MMSYSERR_NOERROR) { midi_send_failed(sent, &running); break; }
      engine.midi_sent++; quarter++; piece = (piece + 1) % 8;
    }
    LeaveCriticalSection(&engine.midi_lock);
  }
  CancelWaitableTimer(timer); CloseHandle(timer);
  if (priority) AvRevertMmThreadCharacteristics(priority);
  return 0;
}
