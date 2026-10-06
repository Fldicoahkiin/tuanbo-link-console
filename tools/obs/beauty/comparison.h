// On-demand, owner-only paired preview. Never changes the formal filter controls.
struct comparison {
    HANDLE thread, stopped, ready;
    CRITICAL_SECTION lock;
    bool initialized, failed;
    volatile LONG demand;
    char name[160];
    uint8_t *latest;
    uint32_t length, sequence, width, height, capture_width, capture_height;
    uint64_t timestamp, staged_ms, next_capture;
    gs_texrender_t *render;
    gs_stagesurf_t *original, *processed;
};

static bool comparison_io(struct comparison *state, HANDLE pipe, void *data, DWORD size, bool writing)
{
    while (size) {
        OVERLAPPED operation = {0};
        operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!operation.hEvent) return false;
        DWORD count = 0;
        BOOL done = writing ? WriteFile(pipe, data, size, &count, &operation) : ReadFile(pipe, data, size, &count, &operation);
        if (!done && GetLastError() == ERROR_IO_PENDING) {
            HANDLE events[2] = {state->stopped, operation.hEvent};
            if (WaitForMultipleObjects(2, events, FALSE, 2000) != WAIT_OBJECT_0 + 1) CancelIoEx(pipe, &operation);
            done = GetOverlappedResult(pipe, &operation, &count, TRUE);
        }
        CloseHandle(operation.hEvent);
        if (!done || !count) return false;
        data = (uint8_t *)data + count; size -= count;
    }
    return true;
}

static DWORD WINAPI comparison_serve(void *opaque)
{
    struct comparison *state = opaque;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;OW)(A;;GA;;;SY)", SDDL_REVISION_1, &descriptor, NULL)) return 1;
    SECURITY_ATTRIBUTES security = {sizeof(security), descriptor, FALSE};
    uint8_t *packet = malloc(LIVE_BYTES * 2 + 32);
    if (!packet) { LocalFree(descriptor); return 1; }
    while (WaitForSingleObject(state->stopped, 0) == WAIT_TIMEOUT) {
        HANDLE pipe = CreateNamedPipeA(state->name, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 64, 0, &security);
        if (pipe == INVALID_HANDLE_VALUE) { blog(LOG_ERROR, "[tblink-beauty] comparison pipe creation failed: %lu", GetLastError()); break; }
        OVERLAPPED operation = {0}; operation.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
        if (!operation.hEvent) { CloseHandle(pipe); break; }
        BOOL connected = ConnectNamedPipe(pipe, &operation);
        DWORD error = GetLastError(), count = 0;
        if (!connected && error == ERROR_PIPE_CONNECTED) connected = TRUE;
        else if (!connected && error == ERROR_IO_PENDING) {
            HANDLE events[2] = {state->stopped, operation.hEvent};
            if (WaitForMultipleObjects(2, events, FALSE, INFINITE) != WAIT_OBJECT_0 + 1) CancelIoEx(pipe, &operation);
            connected = GetOverlappedResult(pipe, &operation, &count, TRUE);
        }
        CloseHandle(operation.hEvent);
        if (!connected) { CloseHandle(pipe); continue; }
        ResetEvent(state->ready);
        InterlockedExchange(&state->demand, 1);
        while (WaitForSingleObject(state->stopped, 0) == WAIT_TIMEOUT) {
            HANDLE events[2] = {state->stopped, state->ready};
            if (WaitForMultipleObjects(2, events, FALSE, 2000) != WAIT_OBJECT_0 + 1) break;
            EnterCriticalSection(&state->lock);
            uint32_t length = state->length;
            uint32_t header[6] = {0x31434254u, state->width, state->height, state->width * 4, length, state->sequence};
            memcpy(packet, header, 24); memcpy(packet + 24, &state->timestamp, 8);
            memcpy(packet + 32, state->latest, length * 2);
            LeaveCriticalSection(&state->lock);
            if (!comparison_io(state, pipe, packet, 32 + length * 2, true)) break;
            uint8_t ack = 0;
            if (!comparison_io(state, pipe, &ack, 1, false) || ack != 1) break;
        }
        InterlockedExchange(&state->demand, 0);
        DisconnectNamedPipe(pipe); CloseHandle(pipe);
    }
    free(packet); LocalFree(descriptor); return 0;
}

static bool comparison_open(struct comparison *state, const char *channel)
{
    InitializeCriticalSection(&state->lock); state->initialized = true;
    snprintf(state->name, sizeof(state->name), "\\\\.\\pipe\\tblink-beauty-compare-%s", channel + strlen("Local\\tblink-beauty-"));
    state->stopped = CreateEventW(NULL, TRUE, FALSE, NULL);
    state->ready = CreateEventW(NULL, FALSE, FALSE, NULL);
    state->latest = malloc(LIVE_BYTES * 2);
    if (!state->stopped || !state->ready || !state->latest) return false;
    state->thread = CreateThread(NULL, 0, comparison_serve, state, 0, NULL);
    return state->thread != NULL;
}

static void comparison_close(struct comparison *state)
{
    if (state->stopped) SetEvent(state->stopped);
    if (state->thread) { WaitForSingleObject(state->thread, INFINITE); CloseHandle(state->thread); }
    if (state->stopped) CloseHandle(state->stopped);
    if (state->ready) CloseHandle(state->ready);
    if (state->initialized) DeleteCriticalSection(&state->lock);
    free(state->latest);
    obs_enter_graphics();
    gs_texrender_destroy(state->render);
    gs_stagesurface_destroy(state->original); gs_stagesurface_destroy(state->processed);
    obs_leave_graphics();
}

static void comparison_capture(struct comparison *state, obs_source_t *source, gs_effect_t *effect, uint32_t width, uint32_t height)
{
    if (state->failed || !InterlockedCompareExchange(&state->demand, 0, 0)) return;
    struct { gs_eparam_t *param; void *value; size_t size; } saved[64] = {{0}};
    size_t saved_count = 0;
    double scale = fmin(1.0, (double)LIVE_EDGE / (width > height ? width : height));
    uint32_t w = (uint32_t)(width * scale), h = (uint32_t)(height * scale);
    uint64_t now = GetTickCount64();
    if (!w || !h) return;
    if (state->capture_width != w || state->capture_height != h) {
        gs_stagesurface_destroy(state->original); gs_stagesurface_destroy(state->processed);
        state->original = gs_stagesurface_create(w, h, GS_RGBA);
        state->processed = gs_stagesurface_create(w, h, GS_RGBA);
        state->capture_width = w; state->capture_height = h;
        state->staged_ms = 0;
    }
    if (!state->original || !state->processed) goto failed;
    if (state->staged_ms && now - state->staged_ms > 250) state->staged_ms = 0;
    if (state->staged_ms && now > state->staged_ms) {
        uint8_t *original = NULL, *processed = NULL; uint32_t original_stride = 0, processed_stride = 0;
        if (!gs_stagesurface_map(state->original, &original, &original_stride)) goto failed;
        if (!gs_stagesurface_map(state->processed, &processed, &processed_stride)) { gs_stagesurface_unmap(state->original); goto failed; }
        if (TryEnterCriticalSection(&state->lock)) {
            state->width = w; state->height = h;
            state->length = w * h * 4;
            for (uint32_t y = 0; y < h; ++y) {
                memcpy(state->latest + y * w * 4, original + y * original_stride, w * 4);
                memcpy(state->latest + state->length + y * w * 4, processed + y * processed_stride, w * 4);
            }
            state->timestamp = state->staged_ms; state->sequence++;
            LeaveCriticalSection(&state->lock); SetEvent(state->ready);
        }
        gs_stagesurface_unmap(state->original); gs_stagesurface_unmap(state->processed); state->staged_ms = 0;
    }
    if (now < state->next_capture) return;
    state->next_capture = now + 67;
    if (!state->render) state->render = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
    if (!state->render) goto failed;
    // OBS clears every effect parameter at technique end. Snapshot this frame's
    // explicit values and restore before each pass and before formal output.
    saved_count = gs_effect_get_num_params(effect);
    if (saved_count > 64) { saved_count = 0; goto failed; }
    for (size_t i = 0; i < saved_count; ++i) {
        saved[i].param = gs_effect_get_param_by_idx(effect, i);
        saved[i].size = gs_effect_get_val_size(saved[i].param);
        saved[i].value = gs_effect_get_val(saved[i].param);
    }
    for (int pass = 0; pass < 2; ++pass) {
        for (size_t i = 0; i < saved_count; ++i)
            if (saved[i].value) gs_effect_set_val(saved[i].param, saved[i].value, saved[i].size);
        gs_texrender_reset(state->render);
        if (!gs_texrender_begin(state->render, w, h)) goto failed;
        struct vec4 clear = {0}; gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
        gs_ortho(0, (float)w, 0, (float)h, -100, 100);
        gs_blend_state_push(); gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
        obs_source_process_filter_tech_end(source, effect, w, h, pass ? "Draw" : "Raw");
        gs_blend_state_pop(); gs_texrender_end(state->render);
        gs_stage_texture(pass ? state->processed : state->original, gs_texrender_get_texture(state->render));
    }
    for (size_t i = 0; i < saved_count; ++i) {
        if (saved[i].value) gs_effect_set_val(saved[i].param, saved[i].value, saved[i].size);
        bfree(saved[i].value);
    }
    state->staged_ms = now; return;
failed:
    for (size_t i = 0; i < saved_count; ++i) {
        if (saved[i].value) gs_effect_set_val(saved[i].param, saved[i].value, saved[i].size);
        bfree(saved[i].value);
    }
    state->failed = true;
    blog(LOG_ERROR, "[tblink-beauty] comparison capture failed; preview stopped, formal output unchanged");
}
