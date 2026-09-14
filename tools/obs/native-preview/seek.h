// Local media seek transport. Replies acknowledge the API call, not a rendered frame.
static HANDLE seek_worker;
static void *(*seek_source)(const char *);
static void (*seek_release)(void *);
static const char *(*seek_id)(void *);
static void (*seek_time)(void *, int64_t);
static void (*seek_pause)(void *, bool);
static void (*seek_restart)(void *);
static int (*seek_state)(void *);
static void (*seek_add_tick)(void (*)(void *, float), void *);
static void (*seek_remove_tick)(void (*)(void *, float), void *);
static HANDLE seek_tick_event;
static volatile LONG seek_ticks;
static void seek_tick(void *unused, float seconds) { (void)unused; (void)seconds; InterlockedIncrement(&seek_ticks); SetEvent(seek_tick_event); }
static bool drain_playing_frames(void) {
    LONG first = InterlockedCompareExchange(&seek_ticks, 0, 0);
    HANDLE events[2] = {stopped, seek_tick_event};
    while (InterlockedCompareExchange(&seek_ticks, 0, 0) - first < 2) {
        if (WaitForMultipleObjects(2, events, FALSE, 2000) != WAIT_OBJECT_0 + 1) return false;
    }
    return true;
}
static DWORD WINAPI serve_seek(void *unused) {
    (void)unused;
    wchar_t name[128]; swprintf(name, 128, L"\\\\.\\pipe\\tblink-obs-seek-%lu", GetCurrentProcessId());
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;OW)(A;;GA;;;SY)", SDDL_REVISION_1, &descriptor, NULL)) return 1;
    SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
    while (!stopping) {
        HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 64, 2048, 0, &security);
        if (pipe == INVALID_HANDLE_VALUE) break;
        if (connect_client(pipe)) {
            uint8_t packet[1040];
            if (transfer(pipe, packet, sizeof(packet), false)) {
                uint32_t magic, paused, result = 1; int64_t ms;
                memcpy(&magic, packet, 4); memcpy(&paused, packet + 4, 4); memcpy(&ms, packet + 8, 8);
                char *source_name = (char *)packet + 16;
                if (magic == 0x31534254 && paused <= 1 && ms >= 0 && ms <= 86400000 && memchr(source_name, 0, 1024)
                    && strncmp(source_name, "团播联动台·素材·", strlen("团播联动台·素材·")) == 0) {
                    void *source = seek_source(source_name);
                    if (source) {
                        const char *id = seek_id(source);
                        if (id && strcmp(id, "ffmpeg_source") == 0) {
                            int state = seek_state(source);
                            if (state == 5 || state == 6) {
                                seek_restart(source);
                                if (drain_playing_frames()) state = seek_state(source);
                            }
                            if (state != 1 && state != 4) result = 4;
                            else {
                                seek_pause(source, paused != 0);
                                if ((state != 4 && !drain_playing_frames()) || stopping) result = 4;
                                else { seek_time(source, ms); result = 0; }
                            }
                        } else result = 3;
                        seek_release(source);
                    } else result = 2;
                }
                if (transfer(pipe, &result, sizeof(result), true)) {
                    uint8_t ack; transfer(pipe, &ack, 1, false);
                }
            }
        }
        DisconnectNamedPipe(pipe); CloseHandle(pipe);
    }
    LocalFree(descriptor); return 0;
}
static bool load_seek(HMODULE obs) {
    seek_source = (void *)GetProcAddress(obs, "obs_get_source_by_name");
    seek_release = (void *)GetProcAddress(obs, "obs_source_release");
    seek_id = (void *)GetProcAddress(obs, "obs_source_get_id");
    seek_time = (void *)GetProcAddress(obs, "obs_source_media_set_time");
    seek_pause = (void *)GetProcAddress(obs, "obs_source_media_play_pause");
    seek_restart = (void *)GetProcAddress(obs, "obs_source_media_restart");
    seek_state = (void *)GetProcAddress(obs, "obs_source_media_get_state");
    seek_add_tick = (void *)GetProcAddress(obs, "obs_add_tick_callback");
    seek_remove_tick = (void *)GetProcAddress(obs, "obs_remove_tick_callback");
    return seek_source && seek_release && seek_id && seek_time && seek_pause && seek_restart && seek_state && seek_add_tick && seek_remove_tick;
}
