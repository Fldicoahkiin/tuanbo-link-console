#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <string.h>

/* P1 1.14.2 asks midiOutGetDevCapsW for 76 bytes (the input structure size).
 * Windows MIDI Services rejects this with MMSYSERR_INVALPARAM. Query into a
 * full output structure, then copy only the caller's requested 76 bytes.
 * No MIDI messages or clocks are generated or changed by this library.
 */
typedef MMRESULT (WINAPI *GetCaps)(UINT_PTR, LPMIDIOUTCAPSW, UINT);
static INIT_ONCE initialized = INIT_ONCE_STATIC_INIT;
static GetCaps systemGetCaps;

static BOOL CALLBACK initialize(PINIT_ONCE once, PVOID parameter, PVOID *context) {
    (void)once; (void)parameter; (void)context;
    WCHAR path[MAX_PATH];
    UINT length = GetSystemDirectoryW(path, MAX_PATH);
    if (length == 0 || length + 11 >= MAX_PATH) return FALSE;
    lstrcatW(path, L"\\winmm.dll");
    HMODULE module = LoadLibraryExW(path, NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module) return FALSE;
    systemGetCaps = (GetCaps)GetProcAddress(module, "midiOutGetDevCapsW");
    return systemGetCaps != NULL;
}

MMRESULT WINAPI tblinkMidiOutGetDevCapsW(UINT_PTR device, LPMIDIOUTCAPSW caps, UINT size) {
    if (!InitOnceExecuteOnce(&initialized, initialize, NULL, NULL)) return MMSYSERR_NODRIVER;
    if (size != 76 || caps == NULL) return systemGetCaps(device, caps, size);
    MIDIOUTCAPSW complete = {0};
    MMRESULT result = systemGetCaps(device, &complete, sizeof(complete));
    if (result == MMSYSERR_NOERROR) memcpy(caps, &complete, size);
    return result;
}
