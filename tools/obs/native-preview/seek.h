// Local media seek transport. Replies acknowledge the API call, not a rendered frame.
#define SEEK_WORKERS 4
static HANDLE seek_workers[SEEK_WORKERS];
static SRWLOCK seek_sources_lock = SRWLOCK_INIT;
static void *seek_sources[SEEK_WORKERS];
static bool claim_seek(void *source) {
    bool claimed = false;
    AcquireSRWLockExclusive(&seek_sources_lock);
    for (unsigned i = 0; i < SEEK_WORKERS; i++) if (seek_sources[i] == source) goto done;
    for (unsigned i = 0; i < SEEK_WORKERS; i++) if (!seek_sources[i]) { seek_sources[i] = source; claimed = true; break; }
done:
    ReleaseSRWLockExclusive(&seek_sources_lock); return claimed;
}
static void release_seek(void *source) {
    AcquireSRWLockExclusive(&seek_sources_lock);
    for (unsigned i = 0; i < SEEK_WORKERS; i++) if (seek_sources[i] == source) seek_sources[i] = NULL;
    ReleaseSRWLockExclusive(&seek_sources_lock);
}
static void *(*seek_source)(const char *);
static void (*seek_release)(void *);
static const char *(*seek_id)(void *);
static bool seek_supported_id(const char *id) {
    if (!id) return false;
#ifdef TBLINK_SEEK_DIAGNOSTIC
    if (strcmp(id, "tblink_seek_diagnostic") == 0) return true;
#endif
    return strcmp(id, "ffmpeg_source") == 0;
}
static void (*seek_time)(void *, int64_t);
static void (*seek_pause)(void *, bool);
static void (*seek_restart)(void *);
static int (*seek_state)(void *);
static void (*seek_inc_showing)(void *);
static void (*seek_dec_showing)(void *);
static int64_t (*seek_get_time)(void *);
static int64_t (*seek_get_duration)(void *);
static uint32_t (*seek_width)(void *);
static bool (*seek_unbuffered)(const void *);
static void (*seek_set_unbuffered)(void *, bool);
static void (*seek_add_tick)(void (*)(void *, float), void *);
static void (*seek_remove_tick)(void (*)(void *, float), void *);
static volatile LONG seek_ticks;
static void seek_tick(void *unused, float seconds) { (void)unused; (void)seconds; InterlockedIncrement(&seek_ticks); }
static bool drain_playing_frames(void) {
    LONG first = InterlockedCompareExchange(&seek_ticks, 0, 0);
    ULONGLONG started = GetTickCount64();
    while (InterlockedCompareExchange(&seek_ticks, 0, 0) - first < 2) {
        if (GetTickCount64() - started >= 2000 || WaitForSingleObject(stopped, 2) != WAIT_TIMEOUT) return false;
    }
    return true;
}
static bool prime_decoder(void *source, bool restart_retained, bool has_video) {
    int state = seek_state(source);
    int64_t before = seek_get_time(source), duration = seek_get_duration(source);
    int64_t previous = before;
    unsigned advances = 0;
    ULONGLONG started = GetTickCount64();
    /* A newly opened ffmpeg source already owns its initial asynchronous reset.
     * Issuing Restart queues a second reset, which may clear Pause after the
     * first frames appeared. Resume that decoder; only ended/stopped sources
     * need a new reset. Observe advancing decoded positions before pausing. */
    if (!restart_retained && (state == 1 || state == 4) && !(duration > 0 && before >= duration - 1)) seek_pause(source, false);
    else seek_restart(source);
    while (!stopping && GetTickCount64() - started < 2000) {
        int64_t cursor = seek_get_time(source);
        if (cursor < previous) advances = 0;
        else if (cursor > previous) advances++;
        previous = cursor;
        if (advances >= 2 && seek_state(source) == 1 && (!has_video || seek_width(source) > 0)) return drain_playing_frames();
        if (WaitForSingleObject(stopped, 1) == WAIT_OBJECT_0) break;
    }
    return false;
}
static DWORD WINAPI serve_seek(void *unused) {
    (void)unused;
    wchar_t name[128]; swprintf(name, 128, L"\\\\.\\pipe\\tblink-obs-seek-%lu", GetCurrentProcessId());
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!pipe_security(&descriptor)) return 1;
    SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
    while (!stopping) {
        HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, SEEK_WORKERS, 64, 2048, 0, &security);
        if (pipe == INVALID_HANDLE_VALUE) break;
        if (connect_client(pipe)) {
            uint8_t packet[1040];
            if (transfer(pipe, packet, sizeof(packet), false)) {
                uint32_t magic, paused, result = 1; int64_t ms;
                memcpy(&magic, packet, 4); memcpy(&paused, packet + 4, 4); memcpy(&ms, packet + 8, 8);
                char *source_name = (char *)packet + 16;
                if (magic == 0x31534254 && paused <= 5 && ms >= 0 && ms <= 86400000 && (paused < 2 || ms == 0) && memchr(source_name, 0, 1024)
                    && strncmp(source_name, "团播联动台·素材·", strlen("团播联动台·素材·")) == 0) {
                    void *source = seek_source(source_name);
                    if (source) {
                        const char *id = seek_id(source);
                        if (seek_supported_id(id) && claim_seek(source)) {
                            /* A hidden ffmpeg source ignores Restart. Hold only
                             * a showing reference; never switch the program or
                             * insert the source into a display. Release on every
                             * exit, including shutdown and decoder failure. */
                            if (paused >= 2) seek_inc_showing(source);
                            int state = seek_state(source);
                            // Modes 4/5 prime audio-only inputs; they still must
                            // advance their native media clock before pausing.
                            if (paused >= 2) state = prime_decoder(source, paused == 3 || paused == 5, paused < 4) ? seek_state(source) : 0;
                            if (paused < 2 && (state == 5 || state == 6)) {
                                seek_restart(source);
                                if (drain_playing_frames()) state = seek_state(source);
                            }
                            if (state != 1 && state != 4) result = 4;
                            else {
                                bool buffered = !seek_unbuffered(source);
                                /* Pause does not empty libobs' already queued
                                 * video frames. Drain the newest queued frame
                                 * before positioning, or it can overwrite the
                                 * seek callback's texture afterwards. */
                                if (paused && buffered) seek_set_unbuffered(source, true);
                                seek_pause(source, paused != 0);
                                if ((state != 4 && !drain_playing_frames()) || stopping) result = 4;
                                else { seek_time(source, ms); result = 0; }
                                if (paused && buffered) seek_set_unbuffered(source, false);
                            }
                            if (paused >= 2) seek_dec_showing(source);
                            release_seek(source);
                        } else result = seek_supported_id(id) ? 5 : 3;
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
    seek_inc_showing = (void *)GetProcAddress(obs, "obs_source_inc_showing");
    seek_dec_showing = (void *)GetProcAddress(obs, "obs_source_dec_showing");
    seek_get_time = (void *)GetProcAddress(obs, "obs_source_media_get_time");
    seek_get_duration = (void *)GetProcAddress(obs, "obs_source_media_get_duration");
    seek_width = (void *)GetProcAddress(obs, "obs_source_get_width");
    seek_unbuffered = (void *)GetProcAddress(obs, "obs_source_async_unbuffered");
    seek_set_unbuffered = (void *)GetProcAddress(obs, "obs_source_set_async_unbuffered");
    seek_add_tick = (void *)GetProcAddress(obs, "obs_add_tick_callback");
    seek_remove_tick = (void *)GetProcAddress(obs, "obs_remove_tick_callback");
    return seek_source && seek_release && seek_id && seek_time && seek_pause && seek_restart && seek_state && seek_inc_showing && seek_dec_showing && seek_get_time && seek_get_duration && seek_width && seek_unbuffered && seek_set_unbuffered && seek_add_tick && seek_remove_tick;
}
