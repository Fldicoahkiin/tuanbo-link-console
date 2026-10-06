#include "engine.h"
#include <fcntl.h>
#include <io.h>
#include <string.h>

Engine engine;
#define TELEMETRY_CAPACITY 512u
#define TELEMETRY_BYTES 8192u
typedef struct { size_t length; char bytes[TELEMETRY_BYTES]; } TelemetryMessage;
static SRWLOCK telemetry_lock = SRWLOCK_INIT;
static TelemetryMessage telemetry_queue[TELEMETRY_CAPACITY];
static UINT32 telemetry_head, telemetry_count;

static BOOL submit_telemetry(const TelemetryMessage *message) {
  AcquireSRWLockExclusive(&telemetry_lock);
  BOOL available = telemetry_count < TELEMETRY_CAPACITY;
  if (available) {
    telemetry_queue[(telemetry_head + telemetry_count) % TELEMETRY_CAPACITY] = *message;
    telemetry_count++;
  }
  ReleaseSRWLockExclusive(&telemetry_lock);
  if (available) SetEvent(engine.telemetry_wake);
  return available;
}
static DWORD WINAPI telemetry_output_worker(void *unused) {
  (void)unused;
  HANDLE events[] = { engine.quit, engine.telemetry_wake };
  while (WaitForMultipleObjects(2, events, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) {
    for (;;) {
      TelemetryMessage message;
      AcquireSRWLockExclusive(&telemetry_lock);
      BOOL available = telemetry_count > 0;
      if (available) { message = telemetry_queue[telemetry_head]; telemetry_head = (telemetry_head + 1) % TELEMETRY_CAPACITY; telemetry_count--; }
      ReleaseSRWLockExclusive(&telemetry_lock);
      if (!available || WaitForSingleObject(engine.quit, 0) == WAIT_OBJECT_0) break;
      // Only this delivery thread may wait for a blocked pipe. Device sampling
      // continues with original QPC values in a fixed, bounded queue.
      EnterCriticalSection(&engine.output_lock);
      BOOL written = fwrite(message.bytes, 1, message.length, stdout) == message.length && fflush(stdout) == 0;
      LeaveCriticalSection(&engine.output_lock);
      if (!written) { SetEvent(engine.quit); return 1; }
    }
  }
  return 0;
}
static UINT32 read_u32(const unsigned char *bytes) { UINT32 value; memcpy(&value, bytes, 4); return value; }
static double read_f64(const unsigned char *bytes) { double value; memcpy(&value, bytes, 8); return value; }
void acknowledge(UINT32 request, UINT32 generation, int32_t code) {
  EnterCriticalSection(&engine.output_lock);
  printf("{\"protocol\":4,\"kind\":\"ack\",\"requestId\":%u,\"generation\":%u,\"ok\":%s,\"code\":%d}\n", request, generation, code >= 0 ? "true" : "false", code);
  fflush(stdout); LeaveCriticalSection(&engine.output_lock);
}
DWORD WINAPI telemetry_worker(void *unused) {
  (void)unused; CoInitializeEx(NULL, COINIT_MULTITHREADED);
  const char *states[] = { "empty", "ready", "playing", "paused", "stopped", "ended", "error" };
  double previous[ANALYSIS_BINS] = {0}, peaks[2] = {0}; unsigned char bins[ANALYSIS_BINS] = {0};
  int16_t samples[ANALYSIS_FRAMES * 2]; UINT32 monitor_epoch = 0;
  ULONGLONG last_analysis = 0;
  // Formal output consumes device observations at 100 Hz. UI/spectrum updates
  // stay at 20 Hz; a 50 ms telemetry period consumed half the output deadline.
  while (WaitForSingleObject(engine.quit, 10) != WAIT_OBJECT_0) {
    EnterCriticalSection(&engine.lock);
    UINT32 generation = engine.generation, state = engine.state, rate = engine.rate, underruns = engine.underruns;
    UINT64 frequency = engine.clock_frequency, qpc = engine.clock_qpc, buffered = engine.loaded - engine.consumed;
    double position = engine.position_ms; int32_t audio_error = engine.audio_error;
    double gain = playback_gain(&engine.envelope, (UINT64)llround(position * rate / 1000.0));
    UINT32 epoch = engine.epoch;
    for (UINT32 i = 0; i < ANALYSIS_FRAMES; i++) {
      UINT32 at = (engine.monitor_at + i) % ANALYSIS_FRAMES;
      samples[i * 2] = engine.monitor[at * 2]; samples[i * 2 + 1] = engine.monitor[at * 2 + 1];
    }
    LeaveCriticalSection(&engine.lock);
    ULONGLONG now = GetTickCount64();
    if (epoch != monitor_epoch || state != PLAYING || now - last_analysis >= 50) {
      if (epoch != monitor_epoch || state != PLAYING) { memset(previous, 0, sizeof(previous)); monitor_epoch = epoch; }
      if (state != PLAYING) memset(samples, 0, sizeof(samples));
      playback_analyze(samples, previous, bins, peaks); last_analysis = now;
    }
    EnterCriticalSection(&engine.midi_lock);
    UINT32 sent = engine.midi_sent; int32_t midi_error = engine.midi_error; double late = engine.max_late;
    double wake_gap = engine.midi_wake_gap_ms, midi_lock_wait = engine.midi_lock_wait_ms,
      audio_lock_wait = engine.midi_audio_lock_wait_ms, midi_send = engine.midi_send_ms;
    LeaveCriticalSection(&engine.midi_lock);
    TelemetryMessage message;
    int size = snprintf(message.bytes, TELEMETRY_BYTES, "{\"protocol\":4,\"kind\":\"clock\",\"generation\":%u,\"state\":\"%s\",\"positionMs\":%.6f,\"qpc100ns\":\"%llu\",\"clockFrequency\":%llu,\"sampleRate\":%u,\"underruns\":%u,\"midiSent\":%u,\"midiError\":%d,\"audioError\":%d,\"maxMidiLatenessMs\":%.6f,\"bufferedFrames\":%llu,\"gain\":%.8f,\"analysis\":{\"fftSize\":2048,\"peaks\":[%.8f,%.8f],\"spectrum\":[",
      generation, states[state], position, (unsigned long long)qpc, (unsigned long long)frequency, rate, underruns, sent, midi_error, audio_error, late, (unsigned long long)buffered, gain, peaks[0], peaks[1]);
    BOOL valid = size > 0 && size < (int)TELEMETRY_BYTES;
    for (unsigned i = 0; valid && i < ANALYSIS_BINS; i++) {
      int written = snprintf(message.bytes + size, TELEMETRY_BYTES - (size_t)size, "%s%u", i ? "," : "", bins[i]);
      valid = written > 0 && written < (int)TELEMETRY_BYTES - size; size += written;
    }
    if (valid) {
      int written = snprintf(message.bytes + size, TELEMETRY_BYTES - (size_t)size,
        "]},\"midiTiming\":{\"wakeGapMs\":%.6f,\"midiLockWaitMs\":%.6f,\"audioLockWaitMs\":%.6f,\"sendMs\":%.6f}}\n", wake_gap, midi_lock_wait, audio_lock_wait, midi_send);
      valid = written > 0 && written < (int)TELEMETRY_BYTES - size; size += written;
    }
    message.length = valid ? (size_t)size : 0;
    if (!valid || !submit_telemetry(&message)) {
      // Sustained loss of the supervising process is a visible channel failure,
      // not an unlimited allocation or silently discarded device observations.
      EnterCriticalSection(&engine.lock);
      if (engine.state != FAILED) {
        if (engine.client) IAudioClient_Stop(engine.client);
        engine.audio_error = (int32_t)HRESULT_FROM_WIN32(ERROR_BUFFER_OVERFLOW); engine.state = FAILED; engine.clock_qpc = 0;
      }
      LeaveCriticalSection(&engine.lock);
    }
  }
  CoUninitialize(); return 0;
}
static DWORD WINAPI commands(void *unused) {
  (void)unused; CoInitializeEx(NULL, COINIT_MULTITHREADED);
  unsigned char header[96], path[PATH_BYTES + 1], device_id[DEVICE_BYTES + 1];
  while (fread(header, 1, 96, stdin) == 96) {
    UINT32 length = read_u32(header + 4), request = read_u32(header + 8), generation = read_u32(header + 12);
    UINT32 op = read_u32(header + 16), bytes = read_u32(header + 72);
    UINT32 device_bytes = read_u32(header + 76);
    if (read_u32(header) != 0x34504254 || bytes > PATH_BYTES || device_bytes > DEVICE_BYTES || length != 96 + bytes + device_bytes || !request || !generation || op < 1 || op > 8 || (op != 1 && (bytes || device_bytes))) break;
    if (bytes && fread(path, 1, bytes, stdin) != bytes) break;
    path[bytes] = 0;
    if (device_bytes && fread(device_id, 1, device_bytes, stdin) != device_bytes) break;
    device_id[device_bytes] = 0;
    UINT32 rate = read_u32(header + 20), device = read_u32(header + 24), fps = read_u32(header + 28);
    double start = read_f64(header + 32), end = read_f64(header + 40), offset = read_f64(header + 48), volume = read_f64(header + 56);
    wchar_t wide[4096], device_wide[1024]; int count = 0, device_count = 0;
    double duration = read_f64(header + 64);
    double base = read_f64(header + 80); UINT32 streaming = read_u32(header + 88);
    BOOL valid = (op == 6 ? isfinite(duration) && duration >= 0 && duration <= 30000 : duration == 0) && read_u32(header + 92) == 0;
    valid = valid && (op == 1 ? isfinite(base) && base >= 0 && base <= start && streaming <= 1 : base == 0 && streaming == 0);
    if (op == 1) {
      count = bytes ? MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (LPCCH)path, (int)bytes, wide, 4095) : 0;
      device_count = device_bytes ? MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (LPCCH)device_id, (int)device_bytes, device_wide, 1023) : 0;
      valid = valid && bytes && !memchr(path, 0, bytes) && count > 0 && device_count > 0 && !memchr(device_id, 0, device_bytes) && (device == 0xffffffffu || device <= 65535) &&
        (rate == 44100 || rate == 48000) && (fps == 24 || fps == 25 || fps == 30) &&
        isfinite(start) && isfinite(end) && isfinite(offset) && isfinite(volume) && start >= 0 && end > start &&
        offset >= 0 && end + offset < 86400000 && volume >= 0 && volume <= 1;
    }
    if (op == 4) valid = valid && isfinite(start) && start >= 0 && start < 86400000;
    if (op == 6) valid = valid && isfinite(volume) && volume >= 0 && volume <= 1;
    if (!valid) { acknowledge(request, generation, (int32_t)E_INVALIDARG); continue; }
    // Finish any in-flight MIDI send before accepting a control boundary. The MIDI
    // worker snapshots state under this same gate, so it cannot send an old snapshot
    // after pause/seek/stop has been acknowledged.
    EnterCriticalSection(&engine.midi_lock);
    EnterCriticalSection(&engine.lock);
    BOOL stale = generation < engine.generation;
    BOOL bad_state = op == 6 && generation != engine.generation;
    if (op == 4) {
      UINT64 frame = (UINT64)llround(start * engine.rate / 1000.0);
      bad_state = !engine.client || frame < engine.start || frame >= engine.end;
    }
    if (!stale && !bad_state) engine.generation = generation;
    LeaveCriticalSection(&engine.lock);
    if (!stale && !bad_state) engine.midi_suspended = TRUE;
    LeaveCriticalSection(&engine.midi_lock);
    if (stale) { acknowledge(request, generation, (int32_t)E_ABORT); continue; }
    if (bad_state) { acknowledge(request, generation, (int32_t)E_INVALIDARG); continue; }
    HRESULT result = E_INVALIDARG;
    if (op == 1) {
      wide[count] = 0; device_wide[device_count] = 0;
      result = audio_prepare(wide, rate, start, end, device_wide, base, streaming != 0);
      if (SUCCEEDED(result)) {
        EnterCriticalSection(&engine.lock); engine.offset_ms = offset; LeaveCriticalSection(&engine.lock);
        audio_volume(volume, 0);
        // MIDI is optional. Its independent failure is reported in health, never an audio failure.
        midi_prepare(device, fps);
      }
    } else if (op == 2) result = audio_play();
    else if (op == 3) result = audio_pause();
    else if (op == 4) { double position = read_f64(header + 32); if (isfinite(position) && position >= 0 && position < 86400000) result = audio_seek(position); }
    else if (op == 5) result = audio_stop();
    else if (op == 6) {
      double volume = read_f64(header + 56);
      if (isfinite(volume) && volume >= 0 && volume <= 1) { audio_volume(volume, duration); result = S_OK; }
    } else if (op == 7) result = S_OK;
    else if (op == 8) { midi_release(); result = S_OK; }
    if (FAILED(result) && op != 6) {
      EnterCriticalSection(&engine.lock);
      if (engine.client) IAudioClient_Stop(engine.client);
      engine.state = FAILED; engine.audio_error = (int32_t)result; engine.clock_qpc = 0;
      LeaveCriticalSection(&engine.lock);
    }
    EnterCriticalSection(&engine.midi_lock); engine.midi_suspended = op == 7; LeaveCriticalSection(&engine.midi_lock);
    acknowledge(request, generation, (int32_t)result);
    if (op == 7) break;
  }
  SetEvent(engine.quit); CoUninitialize(); return 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--devices") == 0) return print_devices();
  if (argc == 2 && strcmp(argv[1], "--device-service") == 0) return serve_devices();
  if (argc == 2 && strcmp(argv[1], "--midi-output") == 0) return serve_midi_output();
  if (argc != 1) return 2;
  _setmode(_fileno(stdin), _O_BINARY);
  InitializeCriticalSection(&engine.lock); InitializeCriticalSection(&engine.output_lock); InitializeCriticalSection(&engine.midi_lock);
  engine.quit = CreateEventW(NULL, TRUE, FALSE, NULL); engine.data_wake = CreateEventW(NULL, FALSE, FALSE, NULL); engine.audio_wake = CreateEventW(NULL, FALSE, FALSE, NULL);
  engine.telemetry_wake = CreateEventW(NULL, FALSE, FALSE, NULL);
  if (!engine.quit || !engine.data_wake || !engine.audio_wake || !engine.telemetry_wake) return 2;
  wchar_t title[80]; swprintf_s(title, 80, L"TBLINK Audio %lu", GetCurrentProcessId());
  // OBS excludes WS_EX_TOOLWINDOW. An invisible owner keeps the non-activating,
  // offscreen capture identity out of the taskbar without excluding it from OBS.
  HWND owner = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, L"STATIC", L"TBLINK Audio Owner", WS_POPUP, -32000, -32000, 1, 1, NULL, NULL, GetModuleHandleW(NULL), NULL);
  if (!owner) return 3;
  HWND window = CreateWindowExW(WS_EX_NOACTIVATE, L"STATIC", title, WS_POPUP, -32000, -32000, 1, 1, owner, NULL, GetModuleHandleW(NULL), NULL);
  if (!window) return 3;
  char window_class[64];
  if (!GetClassNameA(window, window_class, 64) || strcmp(window_class, "Static") != 0) { DestroyWindow(window); DestroyWindow(owner); return 3; }
  ShowWindow(window, SW_SHOWNOACTIVATE);
  printf("{\"protocol\":4,\"kind\":\"ready\",\"pid\":%lu,\"title\":\"TBLINK Audio %lu\",\"windowClass\":\"Static\"}\n", GetCurrentProcessId(), GetCurrentProcessId()); fflush(stdout);
  HANDLE threads[] = { CreateThread(NULL, 0, commands, NULL, 0, NULL), CreateThread(NULL, 0, audio_worker, NULL, 0, NULL),
    CreateThread(NULL, 0, reader_worker, NULL, 0, NULL), CreateThread(NULL, 0, midi_worker, NULL, 0, NULL), CreateThread(NULL, 0, telemetry_worker, NULL, 0, NULL),
    CreateThread(NULL, 0, telemetry_output_worker, NULL, 0, NULL) };
  for (unsigned i = 0; i < 6; i++) if (!threads[i]) SetEvent(engine.quit);
  while (MsgWaitForMultipleObjects(1, &engine.quit, FALSE, INFINITE, QS_ALLINPUT) != WAIT_OBJECT_0) {
    MSG message; while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
  }
  for (unsigned i = 0; i < 6; i++) if (threads[i]) { WaitForSingleObject(threads[i], INFINITE); CloseHandle(threads[i]); }
  CoInitializeEx(NULL, COINIT_MULTITHREADED); audio_release(); MMRESULT released = midi_release(); CoUninitialize();
  DestroyWindow(window); DestroyWindow(owner); CloseHandle(engine.audio_wake); CloseHandle(engine.data_wake); CloseHandle(engine.telemetry_wake); CloseHandle(engine.quit);
  DeleteCriticalSection(&engine.lock); DeleteCriticalSection(&engine.output_lock); DeleteCriticalSection(&engine.midi_lock);
  return released == MMSYSERR_NOERROR ? 0 : 6;
}
