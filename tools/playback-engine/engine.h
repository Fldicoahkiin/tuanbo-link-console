#ifndef TBLINK_ENGINE_H
#define TBLINK_ENGINE_H
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <stdbool.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <mmsystem.h>
#include <stdint.h>
#include <stdio.h>
#include <math.h>
#include "signal.h"
#include "timecode.h"

#define RING_FRAMES 262144u
#define PATH_BYTES 8192u
#define DEVICE_BYTES 2048u
#define PORT_NAME_BYTES 128u
enum { EMPTY, READY, PLAYING, PAUSED, STOPPED, ENDED, FAILED };
typedef struct {
  CRITICAL_SECTION lock, output_lock, midi_lock;
  HANDLE quit, data_wake, audio_wake, telemetry_wake;
  IAudioClient *client;
  IAudioRenderClient *render;
  IAudioClock *clock;
  UINT32 buffer_frames, rate, generation, epoch, state, underruns;
  UINT64 clock_frequency, clock_qpc, start, origin, end, submitted, loaded, consumed, pcm_base;
  BOOL streaming;
  /* The sound card is starving now (2026-11-10 decision 2): one dropout counts once in underruns, however many
   * wake-ups it lasts; the next full fill ends it. */
  BOOL starved;
  double position_ms, offset_ms, volume;
  PlaybackEnvelope envelope;
  int16_t monitor[ANALYSIS_FRAMES * 2];
  UINT32 monitor_at;
  int32_t audio_error;
  wchar_t path[4096];
  int16_t ring[RING_FRAMES * 2];
  HMIDIOUT midi;
  MIDIHDR midi_header;
  unsigned char full_frame[10];
  UINT32 fps, midi_generation, midi_sent, midi_epoch, midi_interruptions;
  /* Timecode sends Windows refused while the port stayed (not 5/6): each relocates with a full frame on the next
   * tick. The host counts them against its limit (output-recovery.ts mtc.sendFailure) and stops timecode there. */
  UINT32 midi_transient;
  /* 29.97 drop-frame labels (fps is then 30), and the operator's choice to relocate receivers with
   * quarter frames alone, without the Full Frame SysEx some USB interfaces do not pass on. */
  BOOL drop_frame, quarter_frames_only;
  int32_t midi_error, midi_worker_error, midi_interruption;
  BOOL midi_suspended;
  /* Timecode port reopen (op 9): the command thread records it, the MIDI worker carries it out without
   * holding midi_lock, because opening a port Windows is still creating blocks for seconds. While
   * reopen_running, only the worker touches midi and midi_header. */
  UINT reopen_device; wchar_t reopen_name[32];
  BOOL reopen_requested, reopen_running;
  UINT32 reopen_ticket, midi_reopens; int32_t midi_reopen_result;
  double max_late;
  double midi_wake_gap_ms, midi_lock_wait_ms, midi_audio_lock_wait_ms, midi_send_ms;
} Engine;
extern Engine engine;
HRESULT audio_prepare(const wchar_t *path, UINT32 rate, double start_ms, double end_ms, const wchar_t *device_id, double base_ms, BOOL streaming);
int print_devices(void);
int serve_devices(bool include_midi);
int serve_midi_output(void);
int serve_midi_input(void);
HRESULT audio_play(void);
HRESULT audio_pause(void);
HRESULT audio_stop(void);
HRESULT audio_seek(double ms);
void audio_volume(double volume, double duration_ms);
void audio_release(void);
DWORD WINAPI audio_worker(void *unused);
DWORD WINAPI reader_worker(void *unused);
DWORD WINAPI telemetry_worker(void *unused);
DWORD WINAPI midi_worker(void *unused);
MMRESULT midi_prepare(UINT device, UINT fps, BOOL drop_frame, BOOL quarter_frames_only, const wchar_t *name);
MMRESULT midi_release(void);
HRESULT midi_request_reopen(UINT device, const wchar_t *name);
void acknowledge(UINT32 request, UINT32 generation, int32_t code);
#endif
