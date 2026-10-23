#include "engine.h"
#include <avrt.h>
#include <string.h>

MMRESULT midi_release(void) {
  EnterCriticalSection(&engine.midi_lock);
  MMRESULT result = MMSYSERR_NOERROR;
  if (engine.midi) {
    result = midiOutReset(engine.midi);
    if (result == MMSYSERR_NOERROR && (engine.midi_header.dwFlags & MHDR_PREPARED)) result = midiOutUnprepareHeader(engine.midi, &engine.midi_header, sizeof(MIDIHDR));
    if (result == MMSYSERR_NOERROR) result = midiOutClose(engine.midi);
    /* An unplugged port (MMSYSERR_NODRIVER) can be neither reset nor closed and its
     * handle is dead. Forget it, so the port opens again by name once it is back. */
    if (result == MMSYSERR_NODRIVER) { (void)midiOutClose(engine.midi); result = MMSYSERR_NOERROR; }
    if (result == MMSYSERR_NOERROR) engine.midi = NULL;
    else engine.midi_error = (int32_t)result;
  }
  LeaveCriticalSection(&engine.midi_lock); return result;
}
MMRESULT midi_prepare(UINT device, UINT fps) {
  MMRESULT released = midi_release();
  if (released != MMSYSERR_NOERROR) return released;
  EnterCriticalSection(&engine.midi_lock);
  engine.fps = fps; engine.midi_error = 0; engine.midi_sent = 0; engine.max_late = 0;
  engine.midi_interruptions = 0; engine.midi_interruption = 0;
  engine.midi_wake_gap_ms = engine.midi_lock_wait_ms = engine.midi_audio_lock_wait_ms = engine.midi_send_ms = 0;
  MMRESULT result = MMSYSERR_NOERROR;
  if (device != 0xffffffffu) {
    if (engine.midi_worker_error) result = MMSYSERR_ERROR;
    else if (device >= midiOutGetNumDevs()) result = MMSYSERR_BADDEVICEID;
    else result = midiOutOpen(&engine.midi, device, 0, 0, CALLBACK_NULL);
    if (result == MMSYSERR_NOERROR) {
      memset(&engine.midi_header, 0, sizeof(MIDIHDR));
      engine.midi_header.lpData = (LPSTR)engine.full_frame; engine.midi_header.dwBufferLength = 10;
      result = midiOutPrepareHeader(engine.midi, &engine.midi_header, sizeof(MIDIHDR));
    }
  }
  engine.midi_error = device != 0xffffffffu && engine.midi_worker_error ? engine.midi_worker_error : (int32_t)result;
  LeaveCriticalSection(&engine.midi_lock); return result;
}
static void parts(UINT64 frame, UINT fps, unsigned char *out) {
  out[3] = (unsigned char)(frame % fps); frame /= fps;
  out[2] = (unsigned char)(frame % 60); frame /= 60;
  out[1] = (unsigned char)(frame % 60); frame /= 60;
  out[0] = (unsigned char)((frame % 24) | ((fps == 24 ? 0 : fps == 25 ? 1 : 3) << 5));
}
/* A stale audio clock (-2) or a late wake-up (-1) is transient: nothing is sent
 * late, the interruption is counted once, and the next fresh clock relocates the
 * receiver with a Full Frame at the actual audio position. Caller holds midi_lock. */
static void midi_interrupt(int32_t reason, BOOL *running) {
  if (*running) { engine.midi_interruptions++; engine.midi_interruption = reason; }
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
    double frame_ms = 1000.0 / engine.fps;
    LARGE_INTEGER now; QueryPerformanceCounter(&now);
    double clock_age_ms = ((double)now.QuadPart * 10000000.0 / frequency.QuadPart - (double)clock_qpc) / 10000.0;
    if (clock_age_ms > frame_ms) { midi_interrupt(-2, &running); LeaveCriticalSection(&engine.midi_lock); continue; }
    if (!running || generation != current_generation || epoch != current_epoch) {
      if ((engine.midi_header.dwFlags & MHDR_INQUEUE) != 0) { LeaveCriticalSection(&engine.midi_lock); continue; }
      parts((UINT64)floor(position / frame_ms), engine.fps, time);
      const unsigned char begin[] = { 0xf0, 0x7f, 0x7f, 1, 1 };
      memcpy(engine.full_frame, begin, 5); memcpy(engine.full_frame + 5, time, 4); engine.full_frame[9] = 0xf7;
      engine.midi_error = (int32_t)midiOutLongMsg(engine.midi, &engine.midi_header, sizeof(MIDIHDR));
      if (engine.midi_error) { LeaveCriticalSection(&engine.midi_lock); continue; }
      engine.midi_sent++; generation = current_generation; epoch = current_epoch; running = TRUE; piece = 0;
      quarter = (UINT64)ceil(position / frame_ms) * 4;
    }
    double late = position - (double)quarter * frame_ms / 4.0;
    if (late > engine.max_late) engine.max_late = late;
    if (late > frame_ms) { midi_interrupt(-1, &running); LeaveCriticalSection(&engine.midi_lock); continue; }
    while ((double)quarter * frame_ms / 4.0 <= position) {
      if (!piece) parts(quarter / 4, engine.fps, time);
      unsigned char nibbles[] = { time[3] & 15, (time[3] >> 4) & 1, time[2] & 15, (time[2] >> 4) & 3,
        time[1] & 15, (time[1] >> 4) & 3, time[0] & 15, (time[0] >> 4) & 7 };
      DWORD message = 0xf1u | ((DWORD)((piece << 4) | nibbles[piece]) << 8);
      LARGE_INTEGER send_started, send_finished; QueryPerformanceCounter(&send_started);
      engine.midi_error = (int32_t)midiOutShortMsg(engine.midi, message);
      QueryPerformanceCounter(&send_finished);
      engine.midi_send_ms = fmax(engine.midi_send_ms, (double)(send_finished.QuadPart - send_started.QuadPart) * 1000.0 / frequency.QuadPart);
      if (engine.midi_error) break;
      engine.midi_sent++; quarter++; piece = (piece + 1) % 8;
    }
    LeaveCriticalSection(&engine.midi_lock);
  }
  CancelWaitableTimer(timer); CloseHandle(timer);
  if (priority) AvRevertMmThreadCharacteristics(priority);
  return 0;
}
