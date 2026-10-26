#include "engine.h"
#include <fcntl.h>
#include <io.h>
#include <string.h>

// Separate non-realtime process for exactly one explicitly named MIDI input.
// Input: the TBM1 header of the output helper with operation 1 (open, UTF-8 name);
// end of stdin closes the port. Output: one reply line, then one line per message:
// {"version":1,"kind":"message","bytes":[...],"at100ns":"..."}. Nothing is dropped
// silently: a full queue or an oversized SysEx ends the process with an error.
#define INPUT_QUEUE 4096u
#define SYSEX_BUFFERS 8u
#define SYSEX_BYTES 4096u
#define SYSEX_LIMIT 65536u

typedef struct { UINT message; DWORD_PTR param1, param2; } InputEvent;
static HMIDIIN input;
static CRITICAL_SECTION queue_lock;
static HANDLE queue_wake, quit;
static InputEvent queue[INPUT_QUEUE];
static UINT32 queue_head, queue_count;
static BOOL queue_overflow, closing;
static MIDIHDR headers[SYSEX_BUFFERS];
static unsigned char buffers[SYSEX_BUFFERS][SYSEX_BYTES];
static unsigned char sysex[SYSEX_LIMIT];
static UINT32 sysex_length;
static UINT64 started_100ns;
static UINT32 invalid_messages;
static LARGE_INTEGER counter_frequency;

static UINT32 packet_u32(const unsigned char *bytes) { UINT32 value; memcpy(&value, bytes, 4); return value; }
static UINT64 packet_u64(const unsigned char *bytes) { UINT64 value; memcpy(&value, bytes, 8); return value; }
static UINT64 now_100ns(void) {
  LARGE_INTEGER now; QueryPerformanceCounter(&now);
  return (UINT64)((double)now.QuadPart * 10000000.0 / counter_frequency.QuadPart);
}

// WinMM callbacks may only use a few system calls; critical sections and SetEvent are among them.
static void CALLBACK input_callback(HMIDIIN handle, UINT message, DWORD_PTR instance, DWORD_PTR param1, DWORD_PTR param2) {
  (void)handle; (void)instance;
  if (message != MIM_DATA && message != MIM_LONGDATA && message != MIM_ERROR && message != MIM_LONGERROR) return;
  EnterCriticalSection(&queue_lock);
  if (queue_count == INPUT_QUEUE) queue_overflow = TRUE;
  else { queue[(queue_head + queue_count) % INPUT_QUEUE] = (InputEvent){ message, param1, param2 }; queue_count++; }
  LeaveCriticalSection(&queue_lock);
  SetEvent(queue_wake);
}

static int32_t open_input(const unsigned char *bytes, UINT32 length) {
  if (!length || length > 1024 || memchr(bytes, 0, length)) return -1;
  wchar_t name[257];
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)length, name, 256);
  if (size <= 0) return -1;
  name[size] = 0;
  UINT count = midiInGetNumDevs(), found = 0, index = 0;
  for (UINT i = 0; i < count; i++) {
    MIDIINCAPSW caps;
    MMRESULT result = midiInGetDevCapsW(i, &caps, sizeof(caps));
    if (result) return (int32_t)result;
    if (wcscmp(name, caps.szPname) == 0) { index = i; found++; }
  }
  if (found != 1) return found ? -3 : -2;
  MMRESULT result = midiInOpen(&input, index, (DWORD_PTR)input_callback, 0, CALLBACK_FUNCTION);
  if (result) { input = NULL; return (int32_t)result; }
  // Recheck the opened handle, not an index which can change during hot-plug.
  MIDIINCAPSW actual;
  result = midiInGetDevCapsW((UINT_PTR)input, &actual, sizeof(actual));
  if (!result && wcscmp(name, actual.szPname) != 0) result = (MMRESULT)-5;
  for (UINT i = 0; !result && i < SYSEX_BUFFERS; i++) {
    headers[i].lpData = (LPSTR)buffers[i]; headers[i].dwBufferLength = SYSEX_BYTES;
    result = midiInPrepareHeader(input, &headers[i], sizeof(MIDIHDR));
    if (!result) result = midiInAddBuffer(input, &headers[i], sizeof(MIDIHDR));
  }
  if (!result) { started_100ns = now_100ns(); result = midiInStart(input); }
  return (int32_t)result;
}

static void write_message(const unsigned char *bytes, UINT32 length, DWORD at_ms) {
  fputs("{\"version\":1,\"kind\":\"message\",\"bytes\":[", stdout);
  for (UINT32 i = 0; i < length; i++) printf(i ? ",%u" : "%u", bytes[i]);
  printf("],\"at100ns\":\"%llu\"}\n", (unsigned long long)(started_100ns + (UINT64)at_ms * 10000u));
}
static UINT32 short_length(unsigned status) {
  if (status < 0x80 || status == 0xf0 || status == 0xf7) return 0;
  if (status < 0xc0 || (status >= 0xe0 && status < 0xf0) || status == 0xf2) return 3;
  if (status < 0xe0 || status == 0xf1 || status == 0xf3) return 2;
  return 1;
}
/* Returns 0, or a process exit code when the stream can no longer be delivered whole. */
static int deliver(const InputEvent *event) {
  if (event->message == MIM_ERROR || event->message == MIM_LONGERROR) {
    invalid_messages++;
    if (event->message == MIM_LONGERROR && !closing) {
      MIDIHDR *header = (MIDIHDR *)event->param1;
      sysex_length = 0;
      if (midiInAddBuffer(input, header, sizeof(MIDIHDR))) return 5;
    }
    return 0;
  }
  if (event->message == MIM_DATA) {
    unsigned char bytes[3] = { (unsigned char)(event->param1 & 0xff), (unsigned char)((event->param1 >> 8) & 0xff), (unsigned char)((event->param1 >> 16) & 0xff) };
    UINT32 length = short_length(bytes[0]);
    // Timing clock and active sensing carry nothing any consumer reads.
    if (!length || bytes[0] == 0xf8 || bytes[0] == 0xfe) return 0;
    write_message(bytes, length, (DWORD)event->param2);
    return 0;
  }
  MIDIHDR *header = (MIDIHDR *)event->param1;
  if (closing) return 0;
  DWORD recorded = header->dwBytesRecorded;
  for (DWORD i = 0; i < recorded; i++) {
    unsigned char value = (unsigned char)header->lpData[i];
    if (value == 0xf0) sysex_length = 0;
    if (sysex_length == SYSEX_LIMIT) return 4;
    sysex[sysex_length++] = value;
    if (value == 0xf7) {
      if (sysex[0] == 0xf0) write_message(sysex, sysex_length, (DWORD)event->param2);
      else invalid_messages++;
      sysex_length = 0;
    }
  }
  header->dwBytesRecorded = 0;
  return midiInAddBuffer(input, header, sizeof(MIDIHDR)) ? 5 : 0;
}

static DWORD WINAPI watch_stdin(void *unused) {
  (void)unused;
  unsigned char byte;
  // Only the end of input is expected after the open request; anything else is a protocol fault.
  size_t read = fread(&byte, 1, 1, stdin);
  if (read) fputs("MIDI input received an unexpected command\n", stderr);
  fflush(stderr); SetEvent(quit);
  return 0;
}

static int close_input(void) {
  int failed = 0;
  if (!input) return 0;
  closing = TRUE;
  if (midiInStop(input)) failed = 1;
  // Reset returns every queued SysEx buffer before the headers are released.
  if (midiInReset(input)) failed = 1;
  for (UINT i = 0; i < SYSEX_BUFFERS; i++) {
    if (!(headers[i].dwFlags & MHDR_PREPARED)) continue;
    for (int waited = 0; (headers[i].dwFlags & MHDR_INQUEUE) && waited < 200; waited++) Sleep(10);
    if (midiInUnprepareHeader(input, &headers[i], sizeof(MIDIHDR))) failed = 1;
  }
  MMRESULT closed = midiInClose(input);
  if (closed) { fprintf(stderr, "MIDI input close failed: %u\n", closed); failed = 1; }
  input = NULL;
  return failed;
}

int serve_midi_input(void) {
  _setmode(_fileno(stdin), _O_BINARY); QueryPerformanceFrequency(&counter_frequency);
  InitializeCriticalSection(&queue_lock);
  queue_wake = CreateEventW(NULL, FALSE, FALSE, NULL); quit = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!queue_wake || !quit) return 2;
  unsigned char header[24], payload[1024];
  if (fread(header, 1, sizeof(header), stdin) != sizeof(header) || memcmp(header, "TBM1", 4)) return 2;
  UINT32 request = packet_u32(header + 4), operation = packet_u32(header + 8), length = packet_u32(header + 12);
  if (!request || operation != 1 || !length || length > sizeof(payload) || packet_u64(header + 16)) return 2;
  if (fread(payload, 1, length, stdin) != length) return 2;
  int32_t code = open_input(payload, length);
  printf("{\"version\":1,\"kind\":\"opened\",\"requestId\":%u,\"code\":%d}\n", request, code); fflush(stdout);
  if (code) { close_input(); return 3; }
  HANDLE watcher = CreateThread(NULL, 0, watch_stdin, NULL, 0, NULL);
  if (!watcher) { close_input(); return 3; }
  int failed = 0;
  HANDLE events[] = { quit, queue_wake };
  while (!failed && WaitForMultipleObjects(2, events, FALSE, INFINITE) == WAIT_OBJECT_0 + 1) {
    for (;;) {
      InputEvent event; BOOL available, overflow;
      EnterCriticalSection(&queue_lock);
      overflow = queue_overflow; available = queue_count > 0;
      if (available) { event = queue[queue_head]; queue_head = (queue_head + 1) % INPUT_QUEUE; queue_count--; }
      LeaveCriticalSection(&queue_lock);
      if (overflow) { fputs("MIDI input queue overflow\n", stderr); failed = 4; break; }
      if (!available) break;
      failed = deliver(&event);
      if (failed) { fprintf(stderr, "MIDI input delivery failed: %d\n", failed); break; }
    }
    if (invalid_messages) { printf("{\"version\":1,\"kind\":\"invalid\",\"count\":%u}\n", invalid_messages); invalid_messages = 0; }
    if (fflush(stdout)) failed = 6;
  }
  if (close_input() && !failed) failed = 3;
  fflush(stderr);
  // The stdin watcher ends with the pipe; the process exit releases it.
  CloseHandle(watcher);
  return failed;
}
