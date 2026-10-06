#define INITGUID
#include "engine.h"
#include <avrt.h>
#include <string.h>

static void seek_locked(UINT64 frame) {
  engine.origin = frame; engine.loaded = engine.consumed = engine.submitted = 0;
  engine.position_ms = (double)frame * 1000.0 / engine.rate;
  engine.clock_qpc = 0;
  engine.envelope.from = engine.envelope.to; engine.envelope.frames = 0;
  memset(engine.monitor, 0, sizeof(engine.monitor)); engine.monitor_at = 0;
  engine.epoch++; SetEvent(engine.data_wake);
}
static void release_locked(void) {
  if (engine.client) IAudioClient_Stop(engine.client);
  if (engine.clock) IAudioClock_Release(engine.clock);
  if (engine.render) IAudioRenderClient_Release(engine.render);
  if (engine.client) IAudioClient_Release(engine.client);
  engine.clock = NULL; engine.render = NULL; engine.client = NULL;
  engine.state = EMPTY; engine.epoch++;
}
void audio_release(void) { EnterCriticalSection(&engine.lock); release_locked(); LeaveCriticalSection(&engine.lock); }
void audio_volume(double volume, double duration_ms) {
  EnterCriticalSection(&engine.lock);
  UINT64 start = engine.origin + engine.submitted;
  double from = playback_gain(&engine.envelope, start);
  engine.envelope = (PlaybackEnvelope){ from, volume, start, (UINT64)llround(duration_ms * engine.rate / 1000.0) };
  engine.volume = volume;
  LeaveCriticalSection(&engine.lock);
}
HRESULT audio_prepare(const wchar_t *path, UINT32 rate, double start_ms, double end_ms, const wchar_t *device_id, double base_ms, BOOL streaming) {
  IMMDeviceEnumerator *enumerator = NULL;
  IMMDevice *device = NULL;
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return HRESULT_FROM_WIN32(GetLastError());
  LARGE_INTEGER size;
  BOOL valid = GetFileSizeEx(file, &size); CloseHandle(file);
  UINT64 start = (UINT64)llround(start_ms * rate / 1000.0), end = (UINT64)llround(end_ms * rate / 1000.0);
  UINT64 base = (UINT64)llround(base_ms * rate / 1000.0);
  if (!valid || size.QuadPart < 0 || end <= start || start < base || start - base >= (UINT64)size.QuadPart / 4 ||
      (!streaming && (size.QuadPart % 4 || end - base > (UINT64)size.QuadPart / 4))) return E_INVALIDARG;
  EnterCriticalSection(&engine.lock);
  release_locked();
  HRESULT hr = CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator, (void **)&enumerator);
  if (SUCCEEDED(hr)) hr = wcscmp(device_id, L"default") == 0
    ? IMMDeviceEnumerator_GetDefaultAudioEndpoint(enumerator, eRender, eMultimedia, &device)
    : IMMDeviceEnumerator_GetDevice(enumerator, device_id, &device);
  if (SUCCEEDED(hr)) hr = IMMDevice_Activate(device, &IID_IAudioClient, CLSCTX_ALL, NULL, (void **)&engine.client);
  WAVEFORMATEX format = { WAVE_FORMAT_PCM, 2, rate, rate * 4, 4, 16, 0 };
  if (SUCCEEDED(hr)) hr = IAudioClient_Initialize(engine.client, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    100000, 0, &format, NULL);
  if (SUCCEEDED(hr)) hr = IAudioClient_SetEventHandle(engine.client, engine.audio_wake);
  if (SUCCEEDED(hr)) hr = IAudioClient_GetBufferSize(engine.client, &engine.buffer_frames);
  if (SUCCEEDED(hr)) hr = IAudioClient_GetService(engine.client, &IID_IAudioRenderClient, (void **)&engine.render);
  if (SUCCEEDED(hr)) hr = IAudioClient_GetService(engine.client, &IID_IAudioClock, (void **)&engine.clock);
  if (SUCCEEDED(hr)) hr = IAudioClock_GetFrequency(engine.clock, &engine.clock_frequency);
  if (SUCCEEDED(hr) && !engine.clock_frequency) hr = E_FAIL;
  if (SUCCEEDED(hr)) {
    engine.rate = rate; engine.start = start; engine.end = end; engine.audio_error = 0; engine.underruns = 0;
    engine.pcm_base = base; engine.streaming = streaming;
    wcscpy_s(engine.path, 4096, path); seek_locked(start); engine.state = READY;
  } else { release_locked(); engine.audio_error = (int32_t)hr; engine.state = FAILED; }
  if (device) IMMDevice_Release(device);
  if (enumerator) IMMDeviceEnumerator_Release(enumerator);
  LeaveCriticalSection(&engine.lock);
  return hr;
}
HRESULT audio_pause(void) {
  EnterCriticalSection(&engine.lock);
  HRESULT hr = engine.client ? IAudioClient_Stop(engine.client) : E_UNEXPECTED;
  if (SUCCEEDED(hr)) engine.state = PAUSED;
  LeaveCriticalSection(&engine.lock); return hr;
}
HRESULT audio_stop(void) {
  EnterCriticalSection(&engine.lock);
  // A failed preparation may never have acquired an endpoint. Stopping it is
  // still a valid, idempotent cancellation, not a second playback failure.
  HRESULT hr = engine.client ? IAudioClient_Stop(engine.client) : S_OK;
  if (SUCCEEDED(hr)) { engine.state = STOPPED; engine.audio_error = 0; engine.clock_qpc = 0; engine.epoch++; }
  LeaveCriticalSection(&engine.lock); SetEvent(engine.data_wake); return hr;
}
HRESULT audio_seek(double ms) {
  EnterCriticalSection(&engine.lock);
  UINT64 frame = (UINT64)llround(ms * engine.rate / 1000.0);
  HRESULT hr = engine.client && frame >= engine.start && frame < engine.end ? IAudioClient_Stop(engine.client) : E_INVALIDARG;
  if (SUCCEEDED(hr)) hr = IAudioClient_Reset(engine.client);
  if (SUCCEEDED(hr)) { seek_locked(frame); engine.state = PAUSED; }
  LeaveCriticalSection(&engine.lock); return hr;
}
static HRESULT fill_locked(void) {
  UINT32 padding = 0;
  HRESULT hr = IAudioClient_GetCurrentPadding(engine.client, &padding);
  if (FAILED(hr)) return hr;
  UINT64 remaining = engine.end - engine.origin - engine.submitted;
  // An empty endpoint mid-stream is a real output starvation, even if the disk
  // ring still contains data. Do not report only disk-buffer shortages.
  if (engine.state == PLAYING && engine.submitted && remaining && !padding) {
    engine.underruns++; return AUDCLNT_E_BUFFER_ERROR;
  }
  UINT32 needed = engine.buffer_frames - padding;
  if (needed > remaining) needed = (UINT32)remaining;
  if (!needed) return S_OK;
  if (engine.loaded - engine.consumed < needed) {
    if (engine.state == PLAYING) { engine.underruns++; return AUDCLNT_E_BUFFER_ERROR; }
    return S_FALSE;
  }
  BYTE *bytes = NULL; hr = IAudioRenderClient_GetBuffer(engine.render, needed, &bytes);
  if (FAILED(hr)) return hr;
  int16_t *target = (int16_t *)bytes;
  for (UINT32 i = 0; i < needed; i++) {
    UINT32 index = (UINT32)((engine.consumed + i) % RING_FRAMES) * 2;
    double gain = playback_gain(&engine.envelope, engine.origin + engine.submitted + i);
    target[i * 2] = (int16_t)lrint(engine.ring[index] * gain);
    target[i * 2 + 1] = (int16_t)lrint(engine.ring[index + 1] * gain);
    UINT32 monitor_index = engine.monitor_at * 2;
    engine.monitor[monitor_index] = target[i * 2]; engine.monitor[monitor_index + 1] = target[i * 2 + 1];
    engine.monitor_at = (engine.monitor_at + 1) % ANALYSIS_FRAMES;
  }
  hr = IAudioRenderClient_ReleaseBuffer(engine.render, needed, 0);
  if (SUCCEEDED(hr)) { engine.consumed += needed; engine.submitted += needed; SetEvent(engine.data_wake); }
  return hr;
}
HRESULT audio_play(void) {
  HRESULT hr = S_FALSE;
  // Only the control thread waits for disk prefill. Playback threads never do I/O.
  for (unsigned i = 0; i < 500 && hr == S_FALSE; i++) {
    EnterCriticalSection(&engine.lock);
    if (engine.state != READY && engine.state != PAUSED) hr = E_UNEXPECTED;
    else hr = fill_locked();
    if (hr == S_OK) { hr = IAudioClient_Start(engine.client); if (SUCCEEDED(hr)) { engine.clock_qpc = 0; engine.state = PLAYING; } }
    LeaveCriticalSection(&engine.lock);
    if (hr == S_FALSE) { if (WaitForSingleObject(engine.quit, 10) == WAIT_OBJECT_0) return E_ABORT; }
  }
  return hr == S_FALSE ? HRESULT_FROM_WIN32(ERROR_TIMEOUT) : hr;
}
DWORD WINAPI audio_worker(void *unused) {
  (void)unused; CoInitializeEx(NULL, COINIT_MULTITHREADED);
  DWORD task = 0; HANDLE priority = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  HANDLE events[] = { engine.quit, engine.audio_wake };
  while (WaitForMultipleObjects(2, events, FALSE, 2) != WAIT_OBJECT_0) {
    EnterCriticalSection(&engine.lock);
    if (engine.state == PLAYING) {
      UINT64 position = 0, qpc = 0;
      HRESULT hr = IAudioClock_GetPosition(engine.clock, &position, &qpc);
      // S_FALSE explicitly means the device reading lost accuracy. Never promote
      // it to a reliable clock or silently fall back to a wall-clock estimate.
      if (hr == S_FALSE) hr = HRESULT_FROM_WIN32(ERROR_TIME_SKEW);
      if (SUCCEEDED(hr)) {
        engine.clock_qpc = qpc;
        double frames = (double)position * engine.rate / engine.clock_frequency;
        engine.position_ms = ((double)engine.origin + fmin(frames, (double)(engine.end - engine.origin))) * 1000.0 / engine.rate;
        if (frames >= (double)(engine.end - engine.origin)) { IAudioClient_Stop(engine.client); engine.state = ENDED; }
        else hr = fill_locked();
      }
      if (FAILED(hr)) { engine.audio_error = (int32_t)hr; engine.state = FAILED; engine.clock_qpc = 0; IAudioClient_Stop(engine.client); }
    }
    LeaveCriticalSection(&engine.lock);
  }
  if (priority) AvRevertMmThreadCharacteristics(priority);
  CoUninitialize(); return 0;
}
DWORD WINAPI reader_worker(void *unused) {
  (void)unused;
  HANDLE file = INVALID_HANDLE_VALUE; UINT32 epoch = 0;
  int16_t block[8192 * 2];
  while (WaitForSingleObject(engine.quit, 0) != WAIT_OBJECT_0) {
    wchar_t path[4096]; UINT64 frame = 0; UINT32 count = 0, next_epoch; BOOL streaming = FALSE;
    EnterCriticalSection(&engine.lock);
    next_epoch = engine.epoch;
    if (engine.state == READY || engine.state == PLAYING || engine.state == PAUSED) {
      UINT64 space = RING_FRAMES - (engine.loaded - engine.consumed);
      UINT64 remaining = engine.end - engine.origin - engine.loaded;
      count = (UINT32)fmin(8192.0, (double)(space < remaining ? space : remaining));
      frame = engine.origin + engine.loaded - engine.pcm_base; streaming = engine.streaming; wcscpy_s(path, 4096, engine.path);
    }
    LeaveCriticalSection(&engine.lock);
    if (epoch != next_epoch && file != INVALID_HANDLE_VALUE) { CloseHandle(file); file = INVALID_HANDLE_VALUE; }
    epoch = next_epoch;
    if (!count) { WaitForSingleObject(engine.data_wake, 10); continue; }
    if (file == INVALID_HANDLE_VALUE) file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    LARGE_INTEGER offset; offset.QuadPart = (LONGLONG)(frame * 4);
    DWORD read = 0; BOOL ok = file != INVALID_HANDLE_VALUE && SetFilePointerEx(file, offset, NULL, FILE_BEGIN) && ReadFile(file, block, count * 4, &read, NULL);
    if (!streaming && read != count * 4) ok = FALSE;
    // A growing PCM may end mid-frame while FFmpeg is writing. Only consume
    // complete stereo frames; the next read resumes at this aligned position.
    count = read / 4;
    DWORD error = ok ? 0 : GetLastError();
    EnterCriticalSection(&engine.lock);
    if (epoch == engine.epoch) {
      if (!ok) { engine.audio_error = (int32_t)HRESULT_FROM_WIN32(error ? error : ERROR_READ_FAULT); engine.state = FAILED; if (engine.client) IAudioClient_Stop(engine.client); }
      else for (UINT32 i = 0; i < count; i++) {
        UINT32 at = (UINT32)(engine.loaded++ % RING_FRAMES) * 2;
        engine.ring[at] = block[i * 2]; engine.ring[at + 1] = block[i * 2 + 1];
      }
    }
    LeaveCriticalSection(&engine.lock);
    if (ok && !count) WaitForSingleObject(engine.data_wake, 10);
  }
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  return 0;
}
