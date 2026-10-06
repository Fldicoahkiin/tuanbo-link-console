#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Acceptance only: this executable is not installed with the production engine.
// Receive callbacks record bounded data; no allocation or stdio in the callback.
typedef struct { DWORD message; LONGLONG qpc; } Record;
static Record records[8192];
static volatile LONG head, tail, overflow;
static LARGE_INTEGER frequency;
static HANDLE quit;
static DWORD WINAPI stop_on_eof(void *unused) {
  (void)unused;
  while (getchar() != EOF) { /* Input is only a lifetime pipe, never commands. */ }
  SetEvent(quit); return 0;
}
static void CALLBACK received(HMIDIIN input, UINT message, DWORD_PTR instance, DWORD_PTR first, DWORD_PTR second) {
  (void)input; (void)instance; (void)second;
  if (message != MIM_DATA || (first & 0xff) != 0xf1) return;
  LONG write = InterlockedCompareExchange(&head, 0, 0), read = InterlockedCompareExchange(&tail, 0, 0);
  if (write - read >= 8192) { InterlockedIncrement(&overflow); return; }
  LARGE_INTEGER qpc; QueryPerformanceCounter(&qpc);
  records[write % 8192].message = (DWORD)first; records[write % 8192].qpc = qpc.QuadPart;
  InterlockedExchange(&head, write + 1);
}
static void name_json(const wchar_t *name) {
  char utf8[512]; WideCharToMultiByte(CP_UTF8, 0, name, -1, utf8, sizeof(utf8), NULL, NULL);
  putchar('"'); for (char *p = utf8; *p; p++) { if (*p == '"' || *p == '\\') putchar('\\'); if ((unsigned char)*p >= 32) putchar(*p); } putchar('"');
}
int main(int argc, char **argv) {
  QueryPerformanceFrequency(&frequency);
  if (argc == 2 && strcmp(argv[1], "--list") == 0) {
    printf("{\"outputs\":[");
    for (UINT i = 0; i < midiOutGetNumDevs(); i++) { MIDIOUTCAPSW caps; if (midiOutGetDevCapsW(i, &caps, sizeof(caps))) return 2;
      if (i) putchar(','); printf("{\"id\":%u,\"name\":", i); name_json(caps.szPname); putchar('}'); }
    printf("],\"inputs\":[");
    for (UINT i = 0; i < midiInGetNumDevs(); i++) { MIDIINCAPSW caps; if (midiInGetDevCapsW(i, &caps, sizeof(caps))) return 2;
      if (i) putchar(','); printf("{\"id\":%u,\"name\":", i); name_json(caps.szPname); putchar('}'); }
    printf("]}\n"); return 0;
  }
  if (argc != 3) return 2;
  UINT device = (UINT)strtoul(argv[1], NULL, 10), seconds = (UINT)strtoul(argv[2], NULL, 10);
  MIDIINCAPSW caps;
  if (device >= midiInGetNumDevs()) { fprintf(stderr, "Probe device index no longer exists\n"); return 3; }
  MMRESULT caps_result = midiInGetDevCapsW(device, &caps, sizeof(caps));
  if (!seconds || seconds > 21660 || caps_result || wcscmp(caps.szPname, L"TBLINK SOAK MTC") != 0) {
    fprintf(stderr, "Probe rejected device=%u duration=%u caps=%u\n", device, seconds, caps_result); return 3;
  }
  HMIDIIN input;
  MMRESULT opened = midiInOpen(&input, device, (DWORD_PTR)received, 0, CALLBACK_FUNCTION);
  if (opened) { fprintf(stderr, "Probe open failed=%u\n", opened); return 4; }
  MMRESULT started = midiInStart(input);
  if (started) { fprintf(stderr, "Probe start failed=%u\n", started); midiInClose(input); return 4; }
  quit = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!quit) { midiInStop(input); midiInClose(input); return 5; }
  HANDLE reader = CreateThread(NULL, 0, stop_on_eof, NULL, 0, NULL);
  if (!reader) { midiInStop(input); midiInClose(input); CloseHandle(quit); return 5; }
  printf("{\"ready\":true}\n"); fflush(stdout);
  ULONGLONG end = GetTickCount64() + seconds * 1000u;
  unsigned pieces[8] = {0}, expected = 0; UINT broken = 0;
  while (GetTickCount64() < end && WaitForSingleObject(quit, 0) != WAIT_OBJECT_0) {
    LONG write = InterlockedCompareExchange(&head, 0, 0), read = InterlockedCompareExchange(&tail, 0, 0);
    while (read < write) {
      Record record = records[read % 8192]; read++;
      unsigned data = (record.message >> 8) & 0x7f, part = data >> 4;
      if (part != expected) broken++;
      expected = (part + 1) % 8; pieces[part] = data & 15;
      if (part == 7) {
        unsigned fps = (pieces[7] >> 1) == 0 ? 24 : (pieces[7] >> 1) == 1 ? 25 : 30;
        unsigned frames = (pieces[1] << 4) | pieces[0], sec = (pieces[3] << 4) | pieces[2], min = (pieces[5] << 4) | pieces[4], hour = ((pieces[7] & 1) << 4) | pieces[6];
        double qpc100ns = (double)record.qpc * 10000000.0 / frequency.QuadPart;
        double ms = ((hour * 3600 + min * 60 + sec) * fps + frames + 2) * 1000.0 / fps;
        printf("{\"qpc100ns\":\"%.0f\",\"timecodeMs\":%.6f,\"broken\":%u,\"overflow\":%ld}\n", qpc100ns, ms, broken, InterlockedCompareExchange(&overflow, 0, 0));
      }
    }
    InterlockedExchange(&tail, read); fflush(stdout); Sleep(5);
  }
  midiInStop(input); midiInReset(input); midiInClose(input); CloseHandle(reader); return 0;
}
