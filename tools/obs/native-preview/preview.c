// OBS 32 ABI. The bridge observes raw rendered video; it never starts an output.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct video_data { uint8_t *data[8]; uint32_t linesize[8]; uint64_t timestamp; };
struct video_scale_info { int format; uint32_t width, height; int range, colorspace; };
struct obs_video_info { const char *graphics_module; uint32_t fps_num, fps_den, base_width, base_height, output_width, output_height; int output_format; uint32_t adapter; bool gpu_conversion; int colorspace, range, scale_type; };
typedef void (*frame_callback)(void *, struct video_data *);
static void (*add_video)(const struct video_scale_info *, uint32_t, frame_callback, void *);
static void (*remove_video)(frame_callback, void *);
static bool (*video_info)(struct obs_video_info *);
static uint32_t (*get_version)(void);
static HANDLE worker, ready, stopped;
static volatile LONG stopping;
static CRITICAL_SECTION lock;
static uint8_t *latest;
static uint32_t width, height, sequence;
static uint64_t timestamp;
static void on_frame(void *unused, struct video_data *frame) {
    (void)unused;
    if (!TryEnterCriticalSection(&lock)) return;
    if (latest && frame->data[0] && frame->linesize[0] >= width * 4) {
        for (uint32_t y = 0; y < height; y++) memcpy(latest + y * width * 4, frame->data[0] + y * frame->linesize[0], width * 4);
        sequence++; timestamp = frame->timestamp; SetEvent(ready);
    }
    LeaveCriticalSection(&lock);
}
static bool transfer(HANDLE pipe, void *bytes, DWORD size, bool writing) {
    while (size && !stopping) {
        OVERLAPPED op = {0}; op.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!op.hEvent) return false;
        DWORD count = 0;
        BOOL done = writing ? WriteFile(pipe, bytes, size, &count, &op) : ReadFile(pipe, bytes, size, &count, &op);
        if (!done && GetLastError() == ERROR_IO_PENDING) {
            HANDLE events[2] = {stopped, op.hEvent};
            if (WaitForMultipleObjects(2, events, FALSE, 2000) != WAIT_OBJECT_0 + 1) CancelIoEx(pipe, &op);
            done = GetOverlappedResult(pipe, &op, &count, TRUE);
        }
        CloseHandle(op.hEvent);
        if (!done || !count) return false;
        bytes = (uint8_t *)bytes + count; size -= count;
    }
    return size == 0;
}
static bool connect_client(HANDLE pipe) {
    OVERLAPPED op = {0}; op.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!op.hEvent) return false;
    BOOL done = ConnectNamedPipe(pipe, &op); DWORD count;
    DWORD error = GetLastError();
    if (!done && error == ERROR_PIPE_CONNECTED) done = TRUE;
    else if (!done && error == ERROR_IO_PENDING) {
        HANDLE events[2] = {stopped, op.hEvent};
        if (WaitForMultipleObjects(2, events, FALSE, INFINITE) != WAIT_OBJECT_0 + 1) CancelIoEx(pipe, &op);
        done = GetOverlappedResult(pipe, &op, &count, TRUE);
    }
    CloseHandle(op.hEvent); return done && !stopping;
}
/* OBS started as administrator owns its objects through the Administrators group, so
 * OWNER RIGHTS alone refuses a normal-privilege console of the same Windows user.
 * Admit that user's SID as well; other users and remote clients stay refused. */
static bool pipe_security(PSECURITY_DESCRIPTOR *descriptor) {
    HANDLE token = NULL;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
    bool built = false;
    DWORD size = 0;
    GetTokenInformation(token, TokenUser, NULL, 0, &size);
    TOKEN_USER *user = size ? malloc(size) : NULL;
    wchar_t *sid = NULL;
    if (user && GetTokenInformation(token, TokenUser, user, size, &size) && ConvertSidToStringSidW(user->User.Sid, &sid)) {
        wchar_t sddl[256];
        int written = swprintf(sddl, 256, L"D:P(A;;GA;;;OW)(A;;GA;;;%ls)(A;;GA;;;SY)", sid);
        built = written > 0 && written < 256 && ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, descriptor, NULL);
    }
    if (sid) LocalFree(sid);
    free(user); CloseHandle(token);
    return built;
}
static DWORD WINAPI serve(void *unused) {
    (void)unused;
    wchar_t name[128]; swprintf(name, 128, L"\\\\.\\pipe\\tblink-obs-preview-%lu", GetCurrentProcessId());
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!pipe_security(&descriptor)) return 1;
    SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
    while (!stopping) {
        HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 64, 0, &security);
        if (pipe == INVALID_HANDLE_VALUE) break;
        if (!connect_client(pipe)) { CloseHandle(pipe); continue; }
        struct obs_video_info info = {0};
        if (stopping || !video_info(&info) || !info.output_width || !info.output_height) { CloseHandle(pipe); continue; }
        double ratio = 960.0 / (info.output_width > info.output_height ? info.output_width : info.output_height);
        if (ratio > 1) ratio = 1;
        width = ((uint32_t)(info.output_width * ratio) + 1) & ~1u;
        height = ((uint32_t)(info.output_height * ratio) + 1) & ~1u;
        uint32_t length = width * height * 4;
        latest = malloc(length); uint8_t *packet = malloc(length + 32);
        if (!latest || !packet) { free(latest); latest = NULL; free(packet); CloseHandle(pipe); continue; }
        sequence = 0; ResetEvent(ready);
        struct video_scale_info conversion = {6, width, height, 0, 0}; // VIDEO_FORMAT_RGBA
        add_video(&conversion, 1, on_frame, NULL);
        while (!stopping) {
            if (WaitForSingleObject(ready, 2000) != WAIT_OBJECT_0) break;
            EnterCriticalSection(&lock);
            uint32_t header[6] = {0x31504254, width, height, width * 4, length, sequence};
            memcpy(packet, header, 24); memcpy(packet + 24, &timestamp, 8); memcpy(packet + 32, latest, length);
            LeaveCriticalSection(&lock);
            if (!transfer(pipe, packet, length + 32, true)) break;
            uint8_t ack;
            if (!transfer(pipe, &ack, 1, false) || ack != 1) break;
        }
        remove_video(on_frame, NULL);
        EnterCriticalSection(&lock); free(latest); latest = NULL; LeaveCriticalSection(&lock);
        free(packet); DisconnectNamedPipe(pipe); CloseHandle(pipe);
    }
    LocalFree(descriptor);
    return 0;
}
#include "seek.h"
__declspec(dllexport) void obs_module_set_pointer(void *module) { (void)module; }
__declspec(dllexport) uint32_t obs_module_ver(void) { HMODULE obs = GetModuleHandleW(L"obs.dll"); get_version = (void *)GetProcAddress(obs, "obs_get_version"); return get_version ? get_version() : 0; }
__declspec(dllexport) const char *obs_module_name(void) { return "TBLINK realtime preview"; }
__declspec(dllexport) const char *obs_module_description(void) { return "Local rendered-frame preview transport"; }
__declspec(dllexport) bool obs_module_load(void) {
    HMODULE obs = GetModuleHandleW(L"obs.dll");
    add_video = (void *)GetProcAddress(obs, "obs_add_raw_video_callback2");
    remove_video = (void *)GetProcAddress(obs, "obs_remove_raw_video_callback");
    video_info = (void *)GetProcAddress(obs, "obs_get_video_info");
    if (!add_video || !remove_video || !video_info || !load_seek(obs)) return false;
    InitializeCriticalSection(&lock); ready = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (!ready) { DeleteCriticalSection(&lock); return false; }
    stopped = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (!stopped) { CloseHandle(ready); DeleteCriticalSection(&lock); return false; }
    stopping = 0; worker = CreateThread(NULL, 0, serve, NULL, 0, NULL);
    if (!worker) { CloseHandle(stopped); CloseHandle(ready); DeleteCriticalSection(&lock); return false; }
    seek_add_tick(seek_tick, NULL);
    for (unsigned i = 0; i < SEEK_WORKERS; i++) {
        seek_workers[i] = CreateThread(NULL, 0, serve_seek, NULL, 0, NULL);
        if (!seek_workers[i]) {
            InterlockedExchange(&stopping, 1); SetEvent(stopped);
            for (unsigned j = 0; j < i; j++) { WaitForSingleObject(seek_workers[j], INFINITE); CloseHandle(seek_workers[j]); }
            seek_remove_tick(seek_tick, NULL);
            WaitForSingleObject(worker, INFINITE); CloseHandle(worker); CloseHandle(stopped); CloseHandle(ready); DeleteCriticalSection(&lock); return false;
        }
    }
    return true;
}
__declspec(dllexport) void obs_module_unload(void) {
    InterlockedExchange(&stopping, 1); SetEvent(ready); SetEvent(stopped);
    WaitForSingleObject(worker, INFINITE);
    for (unsigned i = 0; i < SEEK_WORKERS; i++) { WaitForSingleObject(seek_workers[i], INFINITE); CloseHandle(seek_workers[i]); }
    seek_remove_tick(seek_tick, NULL); CloseHandle(worker); CloseHandle(ready); CloseHandle(stopped); DeleteCriticalSection(&lock);
}
