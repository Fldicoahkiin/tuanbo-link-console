// Prototype only. Uses official OBS 32.0.4 headers, not a reconstructed ABI.
#include <obs-module.h>
#include <math.h>
#include <string.h>
#include <windows.h>

OBS_DECLARE_MODULE()
#include "face.h"
#include "live.h"
#include "comparison.h"
#include "contours.h"
struct beauty {
    struct comparison comparison;
    obs_source_t *source;
    gs_effect_t *effect;
    gs_eparam_t *faces, *eyes, *controls, *count, *pixel;
    gs_eparam_t *grading_param, *sharpen_param;
    float grading[4], sharpen;
    gs_eparam_t *skin_detail_param;
    gs_eparam_t *features_param;
    float skin_detail[3];
    gs_eparam_t *shaping_param;
    float shaping[4];
    gs_eparam_t *lip_contours_param, *lip_bounds_param, *lipstick_param;
    float lipstick, teeth;
    gs_eparam_t *teeth_param;
    gs_eparam_t *makeup_tone_param;
    float makeup_tone[2];
    gs_eparam_t *makeup_points_param, *makeup_bounds_param, *cheeks_param, *makeup_param;
    float makeup[3];
    gs_eparam_t *outline_points_param, *outline_amount_param;
    float outline[4];
    gs_eparam_t *retouch_param;
    float retouch[3];
    CRITICAL_SECTION mutex;
    struct face_state state;
    struct body_state body;
    uint64_t body_accepted_ms;
    gs_texture_t *body_texture;
    gs_texture_t *semantic_texture;
    gs_texture_t *profile_texture;
    gs_eparam_t *profile_guard_param, *profile_enabled_param, *profile_amount_param;
    gs_eparam_t *semantic_mask_param, *semantic_enabled_param;
    gs_eparam_t *body_count_param, *body_points_param, *body_mask_param, *body_amount_param;
    float body_amount[3];
    gs_eparam_t *leg_amount_param;
    float leg_amount[3];
    bool live_mode;
    bool uniform_controls;
    float uniform[4];
    struct live_transport live;
    gs_texrender_t *capture;
    gs_stagesurf_t *stage;
    uint32_t capture_width, capture_height, source_width, source_height;
    uint64_t next_capture, accepted_ms;
    int last_status;
    bool capture_error;
};

static bool number(obs_data_t *item, const char *key, double low, double high, float *out)
{
    if (!obs_data_has_user_value(item, key)) return false;
    obs_data_item_t *field = obs_data_item_byname(item, key);
    bool numeric = field && obs_data_item_gettype(field) == OBS_DATA_NUMBER;
    obs_data_item_release(&field);
    double value = obs_data_get_double(item, key);
    if (!numeric || !isfinite(value) || value < low || value > high) return false;
    *out = (float)value;
    return true;
}

// Geometry comes from the validated fixture or the timestamped live transport.
// Uniform controls replace effect strengths only, never geometry or identity.
static void update(void *opaque, obs_data_t *settings)
{
    struct beauty *filter = opaque;
    struct face_state next = {0};
    bool enabled = obs_data_get_bool(settings, "live_mode");
    obs_data_set_string(settings, "transport_name", filter->live.name);
    obs_data_set_string(settings, "comparison_pipe", filter->comparison.name);
    obs_data_set_int(settings, "controls_version", 14);
    obs_data_set_int(settings, "transport_version", 7);
    EnterCriticalSection(&filter->mutex);
    const char *leg_keys[3] = {"legSlim", "legLength", "neck"};
    for (int i = 0; i < 3; ++i) {
        filter->leg_amount[i] = 0;
        if (obs_data_has_user_value(settings, leg_keys[i]) && !number(settings, leg_keys[i], 0, 1, &filter->leg_amount[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid leg control %s: using zero", leg_keys[i]);
    }
    const char *body_keys[3] = {"bodySlim", "waist", "shoulder"};
    for (int i = 0; i < 3; ++i) {
        filter->body_amount[i] = 0;
        if (obs_data_has_user_value(settings, body_keys[i]) && !number(settings, body_keys[i], i == 2 ? -1 : 0, 1, &filter->body_amount[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid body control %s: using zero", body_keys[i]);
    }
    const char *retouch_keys[3] = {"darkCircles", "nasolabial", "blemish"};
    for (int i = 0; i < 3; ++i) {
        filter->retouch[i] = 0;
        if (obs_data_has_user_value(settings, retouch_keys[i]) && !number(settings, retouch_keys[i], 0, 1, &filter->retouch[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid retouch control %s: using zero", retouch_keys[i]);
    }
    filter->uniform_controls = obs_data_get_bool(settings, "uniform_controls");
    const char *outline_keys[4] = {"jaw", "cheek", "chin", "forehead"};
    for (int i = 0; i < 4; ++i) {
        filter->outline[i] = 0;
        if (obs_data_has_user_value(settings, outline_keys[i]) && !number(settings, outline_keys[i], i < 2 ? 0 : -1, 1, &filter->outline[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid outline control %s: using zero", outline_keys[i]);
    }
    const char *makeup_keys[3] = {"brow", "eyeliner", "blush"};
    for (int i = 0; i < 3; ++i) {
        filter->makeup[i] = 0;
        if (obs_data_has_user_value(settings, makeup_keys[i]) && !number(settings, makeup_keys[i], 0, 1, &filter->makeup[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid makeup control %s: using zero", makeup_keys[i]);
    }
    const char *tone_keys[2] = {"lipstickTone", "blushTone"};
    for (int i = 0; i < 2; ++i) {
        filter->makeup_tone[i] = 0;
        if (obs_data_has_user_value(settings, tone_keys[i]) && !number(settings, tone_keys[i], -1, 1, &filter->makeup_tone[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid makeup tone %s: using zero", tone_keys[i]);
    }
    filter->teeth = 0;
    if (obs_data_has_user_value(settings, "teeth") && !number(settings, "teeth", 0, 1, &filter->teeth))
        blog(LOG_WARNING, "[tblink-beauty] invalid teeth: using zero");
    filter->lipstick = 0;
    if (obs_data_has_user_value(settings, "lipstick") && !number(settings, "lipstick", 0, 1, &filter->lipstick))
        blog(LOG_WARNING, "[tblink-beauty] invalid lipstick: using zero");
    const char *shape_keys[4] = {"nose", "noseLength", "mouth", "eyeDistance"};
    for (size_t i = 0; i < 4; ++i) {
        filter->shaping[i] = 0;
        if (obs_data_has_user_value(settings, shape_keys[i]) && !number(settings, shape_keys[i], i == 0 ? 0 : -1, 1, &filter->shaping[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid shape control %s: using zero", shape_keys[i]);
    }
    const char *skin_keys[3] = {"texture", "evenSkin", "shine"};
    for (size_t i = 0; i < 3; ++i) {
        filter->skin_detail[i] = 0;
        if (obs_data_has_user_value(settings, skin_keys[i]) && !number(settings, skin_keys[i], 0, 1, &filter->skin_detail[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid skin control %s: using zero", skin_keys[i]);
    }
    const char *color_keys[4] = {"exposure", "contrast", "saturation", "temperature"};
    for (size_t i = 0; i < 4; ++i) {
        filter->grading[i] = 0;
        if (obs_data_has_user_value(settings, color_keys[i]) && !number(settings, color_keys[i], -1, 1, &filter->grading[i]))
            blog(LOG_WARNING, "[tblink-beauty] invalid color control %s: using zero", color_keys[i]);
    }
    filter->sharpen = 0;
    if (obs_data_has_user_value(settings, "sharpen") && !number(settings, "sharpen", 0, 1, &filter->sharpen))
        blog(LOG_WARNING, "[tblink-beauty] invalid sharpen: using zero");
    const char *keys[4] = {"smooth", "white", "slim", "eye"};
    for (size_t i = 0; i < 4; ++i) {
        if (!number(settings, keys[i], 0, 1, &filter->uniform[i])) {
            filter->uniform[i] = 0;
            if (filter->uniform_controls) blog(LOG_WARNING, "[tblink-beauty] invalid uniform control %s: using zero", keys[i]);
        }
    }
    if (filter->live_mode != enabled) {
        filter->live.epoch++;
        filter->accepted_ms = 0;
        filter->body_accepted_ms = 0; filter->body.count = 0;
        filter->capture_error = false;
        filter->source_width = filter->source_height = 0;
        memset(&filter->state, 0, sizeof(filter->state));
    }
    filter->live_mode = enabled;
    LeaveCriticalSection(&filter->mutex);
    if (enabled) return;
    const char *json = obs_data_get_string(settings, "fixture_json");
    obs_data_t *packet = *json && strlen(json) <= 262144 ? obs_data_create_from_json(json) : NULL;
    if (packet) {
        obs_data_array_t *array = obs_data_get_array(packet, "faces");
        size_t count = obs_data_array_count(array);
        next.valid = obs_data_get_int(packet, "version") == 3 &&
            strcmp(obs_data_get_string(packet, "mode"), "static-fixture") == 0 && count > 0 && count <= FACE_LIMIT;
        for (size_t i = 0; next.valid && i < count; ++i) {
            obs_data_t *item = obs_data_array_item(array, i);
            next.valid = number(item, "cx", 0, 1, &next.face[i][0]) && number(item, "cy", 0, 1, &next.face[i][1]) &&
                number(item, "rx", 0.005, 0.5, &next.face[i][2]) && number(item, "ry", 0.005, 0.5, &next.face[i][3]) &&
                number(item, "lx", 0, 1, &next.eyes[i][0]) && number(item, "ly", 0, 1, &next.eyes[i][1]) &&
                number(item, "ex", 0, 1, &next.eyes[i][2]) && number(item, "ey", 0, 1, &next.eyes[i][3]) &&
                number(item, "smooth", 0, 1, &next.controls[i][0]) && number(item, "white", 0, 1, &next.controls[i][1]) &&
                number(item, "slim", 0, 1, &next.controls[i][2]) && number(item, "eye", 0, 1, &next.controls[i][3]);
            for (int j = 0; next.valid && j < LANDMARK_VALUES; ++j) {
                char key[16];
                snprintf(key, sizeof(key), "p%d%c", j / 2, j % 2 ? 'y' : 'x');
                next.valid = number(item, key, 0, 1, &next.landmarks[i][j]);
            }
            obs_data_release(item);
        }
        if (next.valid) next.count = (int)count;
        obs_data_array_release(array);
        obs_data_release(packet);
    }
    EnterCriticalSection(&filter->mutex);
    filter->state = next;
    LeaveCriticalSection(&filter->mutex);
    blog(next.valid ? LOG_INFO : LOG_WARNING, "[tblink-beauty] %s; faces=%d; static prototype, NOT live tracking",
         next.valid ? "fixture accepted" : "no valid fixture: original video passthrough", next.count);
}

static void destroy(void *opaque)
{
    struct beauty *filter = opaque;
    comparison_close(&filter->comparison);
    obs_enter_graphics();
    gs_effect_destroy(filter->effect);
    gs_texture_destroy(filter->body_texture);
    gs_texture_destroy(filter->semantic_texture);
    gs_texture_destroy(filter->profile_texture);
    gs_texrender_destroy(filter->capture);
    gs_stagesurface_destroy(filter->stage);
    obs_leave_graphics();
    DeleteCriticalSection(&filter->mutex);
    live_close(&filter->live);
    bfree(filter);
}

static void *create(obs_data_t *settings, obs_source_t *source)
{
    struct beauty *filter = bzalloc(sizeof(*filter));
    filter->source = source;
    InitializeCriticalSection(&filter->mutex);
    if (!live_open(&filter->live)) {
        blog(LOG_ERROR, "[tblink-beauty] local transport creation failed: %lu", GetLastError());
        destroy(filter);
        return NULL;
    }
    if (!comparison_open(&filter->comparison, filter->live.name)) {
        blog(LOG_ERROR, "[tblink-beauty] comparison transport creation failed: %lu", GetLastError());
        destroy(filter); return NULL;
    }
    char *path = obs_module_file("beauty.effect");
    char *error = NULL;
    obs_enter_graphics();
    filter->effect = path ? gs_effect_create_from_file(path, &error) : NULL;
    filter->body_texture = gs_texture_create(BODY_MASK_EDGE, BODY_MASK_EDGE * BODY_LIMIT, GS_R8, 1, NULL, GS_DYNAMIC);
    filter->semantic_texture = gs_texture_create(FACE_MASK_EDGE, FACE_MASK_EDGE, GS_R8, 1, NULL, GS_DYNAMIC);
    filter->profile_texture = gs_texture_create(FACE_MASK_EDGE, FACE_MASK_EDGE, GS_R8, 1, NULL, GS_DYNAMIC);
    obs_leave_graphics();
    bfree(path);
    if (!filter->effect) {
        blog(LOG_ERROR, "[tblink-beauty] shader failed: %s", error ? error : "resource missing");
        bfree(error);
        destroy(filter);
        return NULL;
    }
    bfree(error);
    filter->faces = gs_effect_get_param_by_name(filter->effect, "faces");
    filter->eyes = gs_effect_get_param_by_name(filter->effect, "eyes");
    filter->controls = gs_effect_get_param_by_name(filter->effect, "controls");
    filter->count = gs_effect_get_param_by_name(filter->effect, "face_count");
    filter->pixel = gs_effect_get_param_by_name(filter->effect, "pixel_size");
    filter->grading_param = gs_effect_get_param_by_name(filter->effect, "grading");
    filter->sharpen_param = gs_effect_get_param_by_name(filter->effect, "sharpen");
    filter->skin_detail_param = gs_effect_get_param_by_name(filter->effect, "skin_detail");
    filter->features_param = gs_effect_get_param_by_name(filter->effect, "features");
    filter->shaping_param = gs_effect_get_param_by_name(filter->effect, "shaping");
    filter->lip_contours_param = gs_effect_get_param_by_name(filter->effect, "lip_contours");
    filter->lip_bounds_param = gs_effect_get_param_by_name(filter->effect, "lip_bounds");
    filter->makeup_tone_param = gs_effect_get_param_by_name(filter->effect, "makeup_tone");
    filter->teeth_param = gs_effect_get_param_by_name(filter->effect, "teeth");
    filter->lipstick_param = gs_effect_get_param_by_name(filter->effect, "lipstick");
    filter->makeup_points_param = gs_effect_get_param_by_name(filter->effect, "makeup_points");
    filter->makeup_bounds_param = gs_effect_get_param_by_name(filter->effect, "makeup_bounds");
    filter->cheeks_param = gs_effect_get_param_by_name(filter->effect, "cheeks");
    filter->makeup_param = gs_effect_get_param_by_name(filter->effect, "makeup");
    filter->outline_points_param = gs_effect_get_param_by_name(filter->effect, "outline_points");
    filter->outline_amount_param = gs_effect_get_param_by_name(filter->effect, "outline_amount");
    filter->retouch_param = gs_effect_get_param_by_name(filter->effect, "retouch");
    filter->body_count_param = gs_effect_get_param_by_name(filter->effect, "body_count");
    filter->body_points_param = gs_effect_get_param_by_name(filter->effect, "body_points");
    filter->body_mask_param = gs_effect_get_param_by_name(filter->effect, "body_mask");
    filter->semantic_mask_param = gs_effect_get_param_by_name(filter->effect, "semantic_mask");
    filter->semantic_enabled_param = gs_effect_get_param_by_name(filter->effect, "semantic_enabled");
    if (!filter->semantic_texture || !filter->semantic_mask_param || !filter->semantic_enabled_param) {
        blog(LOG_ERROR, "[tblink-beauty] semantic shader resources missing");
        destroy(filter); return NULL;
    }
    filter->profile_guard_param = gs_effect_get_param_by_name(filter->effect, "profile_guard");
    filter->profile_enabled_param = gs_effect_get_param_by_name(filter->effect, "profile_enabled");
    filter->profile_amount_param = gs_effect_get_param_by_name(filter->effect, "profile_amount");
    if (!filter->profile_texture || !filter->profile_guard_param || !filter->profile_enabled_param || !filter->profile_amount_param) {
        blog(LOG_ERROR, "[tblink-beauty] profile shader resources missing");
        destroy(filter); return NULL;
    }
    filter->body_amount_param = gs_effect_get_param_by_name(filter->effect, "body_amount");
    filter->leg_amount_param = gs_effect_get_param_by_name(filter->effect, "leg_amount");
    if (!filter->leg_amount_param) {
        blog(LOG_ERROR, "[tblink-beauty] leg shader parameter missing");
        destroy(filter); return NULL;
    }
    if (!filter->body_texture || !filter->body_count_param || !filter->body_points_param || !filter->body_mask_param || !filter->body_amount_param) {
        blog(LOG_ERROR, "[tblink-beauty] body shader resources missing");
        destroy(filter); return NULL;
    }
    if (!filter->retouch_param) {
        blog(LOG_ERROR, "[tblink-beauty] retouch shader parameter missing");
        destroy(filter); return NULL;
    }
    if (!filter->outline_points_param || !filter->outline_amount_param) {
        blog(LOG_ERROR, "[tblink-beauty] outline shader parameters missing");
        destroy(filter); return NULL;
    }
    if (!filter->makeup_points_param || !filter->makeup_bounds_param || !filter->cheeks_param || !filter->makeup_param) {
        blog(LOG_ERROR, "[tblink-beauty] makeup shader parameters missing");
        destroy(filter); return NULL;
    }
    if (!filter->teeth_param || !filter->makeup_tone_param || !filter->faces || !filter->eyes || !filter->controls || !filter->count || !filter->pixel || !filter->grading_param || !filter->sharpen_param || !filter->skin_detail_param || !filter->features_param || !filter->shaping_param || !filter->lip_contours_param || !filter->lip_bounds_param || !filter->lipstick_param) {
        blog(LOG_ERROR, "[tblink-beauty] shader contract missing parameters");
        destroy(filter);
        return NULL;
    }
    update(filter, settings);
    return filter;
}

static void capture_frame(struct beauty *filter, uint32_t width, uint32_t height, uint64_t now)
{
    if (filter->capture_error) return;
    double scale = fmin(1.0, (double)LIVE_EDGE / (width > height ? width : height));
    uint32_t w = (uint32_t)(width * scale), h = (uint32_t)(height * scale);
    if (!w || !h) return;
    if (width != filter->source_width || height != filter->source_height) {
        gs_stagesurface_destroy(filter->stage);
        filter->stage = gs_stagesurface_create(w, h, GS_RGBA);
        filter->capture_width = w; filter->capture_height = h;
        filter->source_width = width; filter->source_height = height;
        filter->live.epoch++; filter->accepted_ms = 0;
        filter->body_accepted_ms = 0; filter->body.count = 0;
        memset(&filter->state, 0, sizeof(filter->state));
    }
    if (!filter->stage) goto failed;
    if (now < filter->next_capture) return;
    // Keep the latest analysis input available at up to 30 fps. Detectors read
    // independently and skip superseded frames; they never queue stale input.
    // Keeping a phase also avoids quantizing the interval to two render ticks.
    if (!filter->next_capture) filter->next_capture = now;
    filter->next_capture += ((now - filter->next_capture) / 33 + 1) * 33;
    if (!filter->capture) filter->capture = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
    if (!filter->capture) goto failed;
    gs_texrender_reset(filter->capture);
    if (!gs_texrender_begin(filter->capture, w, h)) goto failed;
    struct vec4 clear = {0};
    gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
    gs_ortho(0, (float)w, 0, (float)h, -100, 100);
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
    obs_source_process_filter_tech_end(filter->source, filter->effect, w, h, "Raw");
    gs_blend_state_pop();
    gs_texrender_end(filter->capture);
    gs_stage_texture(filter->stage, gs_texrender_get_texture(filter->capture));
    // The bounded analysis texture is consumed in this render tick. Retain
    // the capture-start timestamp: GPU readback time is part of result age.
    uint8_t *pixels = NULL; uint32_t stride = 0;
    if (!gs_stagesurface_map(filter->stage, &pixels, &stride)) goto failed;
    bool body_requested = false;
    for (int i = 0; i < 3; ++i) body_requested |= filter->body_amount[i] != 0 || filter->leg_amount[i] != 0;
    live_publish(&filter->live, pixels, stride, w, h, now, body_requested ? 1 : 0);
    gs_stagesurface_unmap(filter->stage);
    return;
failed:
    filter->capture_error = true;
    filter->accepted_ms = 0;
    filter->body_accepted_ms = 0; filter->body.count = 0;
    memset(&filter->state, 0, sizeof(filter->state));
    blog(LOG_ERROR, "[tblink-beauty] GPU analysis capture failed; capture stopped, toggle live mode explicitly to reinitialize");
}

static void render(void *opaque, gs_effect_t *unused)
{
    (void)unused;
    struct beauty *filter = opaque;
    EnterCriticalSection(&filter->mutex);
    bool live_mode = filter->live_mode;
    struct face_state state = filter->state;
    LeaveCriticalSection(&filter->mutex);
    obs_source_t *target = obs_filter_get_target(filter->source);
    uint32_t width = target ? obs_source_get_base_width(target) : 0;
    uint32_t height = target ? obs_source_get_base_height(target) : 0;
    if ((!state.valid && !live_mode) || !width || !height) {
        obs_source_skip_video_filter(filter->source);
        return;
    }
    if (!obs_source_process_filter_begin(filter->source, GS_RGBA, OBS_NO_DIRECT_RENDERING)) return;
    bool fresh = !live_mode;
    if (live_mode) {
        EnterCriticalSection(&filter->mutex);
        uint64_t now = GetTickCount64();
        capture_frame(filter, width, height, now);
        // Readback can block on the GPU. Validate at completion, then use one
        // freshness decision for geometry, skin and grading in this frame.
        now = GetTickCount64();
        if (!filter->capture_error) {
            live_receive(&filter->live, &filter->state, now, &filter->accepted_ms);
            live_receive_body(&filter->live, &filter->body, now, &filter->body_accepted_ms);
        }
        if (!filter->body_accepted_ms || now - filter->body_accepted_ms > LIVE_MAX_AGE) filter->body.count = 0;
        fresh = filter->accepted_ms && now - filter->accepted_ms <= LIVE_MAX_AGE;
        if (!fresh) memset(&filter->state, 0, sizeof(filter->state));
        state = filter->state;
        int status = !fresh ? 3 : state.valid ? 1 : 2;
        if (status != filter->last_status) {
            blog(status == 3 ? LOG_WARNING : LOG_INFO,
                 "[tblink-beauty] channel=%s live status=%d faces=%d profiles=%u accepted=%u age_ms=%llu (1=tracking,2=no faces,3=stale/original)",
                 filter->live.name, status, state.count, state.profile_count, filter->live.accepted,
                 (unsigned long long)(filter->accepted_ms ? now - filter->accepted_ms : 0));
            filter->last_status = status;
        }
        LeaveCriticalSection(&filter->mutex);
    }
    float pixel[2] = {1.0f / width, 1.0f / height};
    EnterCriticalSection(&filter->mutex);
    if (filter->uniform_controls) {
        for (int i = 0; i < state.count; ++i) memcpy(state.controls[i], filter->uniform, sizeof(filter->uniform));
    }
    const float neutral[4] = {0};
    gs_effect_set_val(filter->grading_param, fresh ? filter->grading : neutral, sizeof(filter->grading));
    gs_effect_set_float(filter->sharpen_param, fresh ? filter->sharpen : 0);
    gs_effect_set_val(filter->skin_detail_param, filter->skin_detail, sizeof(filter->skin_detail));
    gs_effect_set_val(filter->shaping_param, filter->shaping, sizeof(filter->shaping));
    gs_effect_set_val(filter->makeup_tone_param, filter->makeup_tone, sizeof(filter->makeup_tone));
    gs_effect_set_float(filter->teeth_param, filter->teeth);
    gs_effect_set_float(filter->lipstick_param, filter->lipstick);
    gs_effect_set_val(filter->makeup_param, filter->makeup, sizeof(filter->makeup));
    gs_effect_set_val(filter->outline_amount_param, filter->outline, sizeof(filter->outline));
    gs_effect_set_val(filter->retouch_param, filter->retouch, sizeof(filter->retouch));
    gs_effect_set_val(filter->body_amount_param, filter->body_amount, sizeof(filter->body_amount));
    gs_effect_set_val(filter->leg_amount_param, filter->leg_amount, sizeof(filter->leg_amount));
    gs_effect_set_int(filter->body_count_param, live_mode ? filter->body.count : 0);
    float body_points[BODY_LIMIT][33][4] = {{{0}}};
    for (uint32_t i = 0; i < filter->body.count; ++i)
        for (int j = 0; j < 33; ++j) memcpy(body_points[i][j], filter->body.joints[i] + j * 3, sizeof(float) * 3);
    gs_effect_set_val(filter->body_points_param, body_points, sizeof(body_points));
    gs_texture_set_image(filter->body_texture, &filter->body.masks[0][0], BODY_MASK_EDGE, false);
    gs_effect_set_texture(filter->body_mask_param, filter->body_texture);
    gs_texture_set_image(filter->semantic_texture, state.semantic_mask, FACE_MASK_EDGE, false);
    gs_effect_set_texture(filter->semantic_mask_param, filter->semantic_texture);
    gs_effect_set_int(filter->semantic_enabled_param, state.semantic_present ? 1 : 0);
    gs_texture_set_image(filter->profile_texture, state.profile_guard, FACE_MASK_EDGE, false);
    gs_effect_set_texture(filter->profile_guard_param, filter->profile_texture);
    gs_effect_set_int(filter->profile_enabled_param, fresh && state.profile_count && state.semantic_present && filter->uniform_controls ? 1 : 0);
    gs_effect_set_val(filter->profile_amount_param, filter->uniform, sizeof(float) * 2);
    LeaveCriticalSection(&filter->mutex);
    gs_effect_set_val(filter->faces, state.face, sizeof(state.face));
    gs_effect_set_val(filter->eyes, state.eyes, sizeof(state.eyes));
    gs_effect_set_val(filter->controls, state.controls, sizeof(state.controls));
    float features[FACE_LIMIT][24] = {{0}};
    const int feature_ids[11] = {1, 98, 327, 61, 291, 0, 17, 13, 14, 152, 10};
    for (int i = 0; i < state.count; ++i)
        for (int j = 0; j < 11; ++j) memcpy(features[i] + j * 2, state.landmarks[i] + feature_ids[j] * 2, sizeof(float) * 2);
    gs_effect_set_val(filter->features_param, features, sizeof(features));
    const int outline_ids[4] = {172, 397, 234, 454};
    float outline_points[FACE_LIMIT][8] = {{0}};
    for (int i = 0; i < state.count; ++i)
        for (int j = 0; j < 4; ++j) memcpy(outline_points[i] + j * 2, state.landmarks[i] + outline_ids[j] * 2, sizeof(float) * 2);
    gs_effect_set_val(filter->outline_points_param, outline_points, sizeof(outline_points));
    float lip_points[FACE_LIMIT][80] = {{0}}, lip_bounds[FACE_LIMIT][4] = {{0}};
    lip_geometry(&state, lip_points, lip_bounds);
    gs_effect_set_val(filter->lip_contours_param, lip_points, sizeof(lip_points));
    gs_effect_set_val(filter->lip_bounds_param, lip_bounds, sizeof(lip_bounds));
    float makeup_points[FACE_LIMIT][160] = {{0}}, makeup_bounds[FACE_LIMIT][16] = {{0}}, cheeks[FACE_LIMIT][4] = {{0}};
    makeup_geometry(&state, makeup_points, makeup_bounds, cheeks);
    gs_effect_set_val(filter->makeup_points_param, makeup_points, sizeof(makeup_points));
    gs_effect_set_val(filter->makeup_bounds_param, makeup_bounds, sizeof(makeup_bounds));
    gs_effect_set_val(filter->cheeks_param, cheeks, sizeof(cheeks));
    gs_effect_set_val(filter->pixel, pixel, sizeof(pixel));
    gs_effect_set_int(filter->count, state.count);
    comparison_capture(&filter->comparison, filter->source, filter->effect, width, height);
    obs_source_process_filter_end(filter->source, filter->effect, width, height);
}

static obs_properties_t *properties(void *opaque)
{
    struct beauty *filter = opaque;
    bool valid = false;
    bool realtime = false;
    bool failed = false;
    if (filter) {
        EnterCriticalSection(&filter->mutex);
        valid = filter->state.valid;
        realtime = filter->live_mode;
        failed = filter->capture_error;
        LeaveCriticalSection(&filter->mutex);
    }
    obs_properties_t *props = obs_properties_create();
    obs_properties_add_bool(props, "live_mode", "实时分析原型（需启动本机分析工作器）");
    obs_properties_add_text(props, "transport_info", filter ? filter->live.name : "无活动通道", OBS_TEXT_INFO);
    obs_properties_add_text(props, "prototype_info", failed ? "GPU 分析帧读取失败，已停止；请检查日志并手动重新启用实时模式。" : realtime ?
        (valid ? "实时原型：有有效分析结果；尚未完成身份跟踪与直播验收。" : "实时原型：无有效人脸或分析结果过期，原画通过。") : valid ?
        "静态图像原型：已加载测试区域。尚无实时跟踪，请勿用于直播。" :
        "静态图像原型：无有效区域，原画通过。尚无实时跟踪，请勿用于直播。", OBS_TEXT_INFO);
    obs_properties_add_text(props, "fixture_json", "静态测试区域 JSON（最多 6 人）", OBS_TEXT_MULTILINE);
    return props;
}

static const char *name(void *unused) { (void)unused; return "联动台美颜（技术原型）"; }
MODULE_EXPORT const char *obs_module_name(void) { return "tblink-beauty"; }
MODULE_EXPORT const char *obs_module_description(void) { return "Multi-face GPU prototype with local pre-filter analysis transport"; }
bool obs_module_load(void)
{
    // OBS caches file effects for the graphics context. Compile during module
    // startup so the first filter creation does not stall a 2-second RPC.
    char *shader_path = obs_module_file("beauty.effect"), *shader_error = NULL;
    obs_enter_graphics();
    gs_effect_t *prepared = shader_path ? gs_effect_create_from_file(shader_path, &shader_error) : NULL;
    gs_effect_destroy(prepared);
    obs_leave_graphics();
    bfree(shader_path);
    if (!prepared) {
        blog(LOG_ERROR, "[tblink-beauty] startup shader failed: %s", shader_error ? shader_error : "resource missing");
        bfree(shader_error); return false;
    }
    bfree(shader_error);
    struct obs_source_info info = {
        .id = "tblink_beauty_prototype", .type = OBS_SOURCE_TYPE_FILTER,
        .output_flags = OBS_SOURCE_VIDEO, .get_name = name,
        .create = create, .destroy = destroy, .update = update,
        .get_properties = properties, .video_render = render,
    };
    obs_register_source(&info);
    blog(LOG_INFO, "[tblink-beauty] registered feasibility prototype; static and live analysis modes");
    return true;
}
