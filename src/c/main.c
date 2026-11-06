// =========================================================================
// SECTION 1: SYSTEM HEADERS & PREPROCESSOR MACROS
// =========================================================================

#include <pebble.h>
// True continuous conversation requires Pebble SDK revision 110+.
// This branch intentionally targets the native MicStream API rather than
// pretending system dictation can provide an always-open microphone.
// Do not build this branch with CloudPebble's older SDK.
#define HA_ENABLE_NATIVE_MIC_STREAM 1

#define MAX_TEXT_LENGTH 2048
// Compile only with an SDK that exports mic_stream_to_phone_start().
#if defined(HA_ENABLE_NATIVE_MIC_STREAM) && defined(PBL_PLATFORM_EMERY) && defined(PBL_MICROPHONE) && !defined(PBL_SDK_FROZEN)
#define HA_MIC_AVAILABLE 1
#else
#define HA_MIC_AVAILABLE 0
#endif
 

#ifdef PBL_SPEAKER
  #define RING_BUFFER_SIZE 16384           
  #define PERSIST_KEY_VOLUME 100           
  #define PLAYBACK_ADPCM_BYTES 800         
  #define PLAYBACK_PCM_SAMPLES (PLAYBACK_ADPCM_BYTES * 2) 
  #define PLAYBACK_INTERVAL_MS 200         
  #define START_BUFFER_THRESHOLD 3000      
  #define STREAM_CLOSE_DELAY_MS 1500       
#endif

// =========================================================================
// SECTION 2: GLOBAL UI STATE MACHINE VARIABLES & POINTERS
// =========================================================================

typedef enum { UI_STATE_IDLE, UI_STATE_THINKING, UI_STATE_RESULTS } UIState;

static UIState s_current_state = UI_STATE_IDLE;
// Conversation mode is an explicit UI state until raw microphone capture
// and HA Assist WebSocket streaming are available in the target SDK.
static bool s_conversation_mode = false;
static bool s_dictation_fallback = false;
static bool s_conversation_dictating = false;
static AppTimer *s_conversation_resume_timer = NULL;
static bool s_conversation_audio_complete = false;

static Window *s_main_window;                   
static ScrollLayer *s_scroll_layer;             
static TextLayer *s_text_layer;                 
static TextLayer *s_status_layer;               
static Layer *s_idle_layer;
static GBitmap *s_logo_bitmap;
static BitmapLayer *s_logo_layer;                     
                  
               
static TextLayer *s_title_layer;                
static TextLayer *s_prompt_layer;
#ifdef PBL_SPEAKER
static TextLayer *s_volume_up_hint_layer;
static TextLayer *s_volume_down_hint_layer;
#endif               
static Layer *s_arrow_layer;                    
static Layer *s_pinwheel_layer;                 
static AppTimer *s_pinwheel_timer = NULL;       
static int s_pinwheel_angle = 0;                
static DictationSession *s_dictation_session;
static bool s_auto_send = true;
static int s_haptic_level = 2; // 0 off, 1 low, 2 medium, 3 high
static TextLayer *s_thinking_transcript_layer;
static char s_thinking_transcript[256];   
static char s_ha_text[MAX_TEXT_LENGTH];     

// =========================================================================
// SECTION 3: SPEAKER INFRASTRUCTURE VARIABLES & TABLES (SPEAKER ONLY)
// =========================================================================

#ifdef PBL_SPEAKER
  static TextLayer *s_volume_text_layer;        
  static float s_volume = 1.0f;                 
  static AppTimer *s_volume_timer = NULL;       
  static uint8_t s_ring_buffer[RING_BUFFER_SIZE]; 
  static uint32_t s_head = 0;                   
  static uint32_t s_tail = 0;                   
  static uint32_t s_buffer_count = 0;           
  static AppTimer *s_playback_timer = NULL;     
  static AppTimer *s_stream_close_timer = NULL; 
  static bool s_speaker_open = false;
  // Preserve PCM bytes rejected by a full speaker queue; never drop a partial write.
  // Ping-pong PCM frames: while one frame drains into the speaker stream,
  // the next is already decoded from the ADPCM ring. The predictor remains
  // continuous across both buffers and between consecutive sentences.
  static int16_t s_pcm_frames[2][PLAYBACK_PCM_SAMPLES];
  static uint32_t s_pcm_lengths[2] = {0,0};
  static uint8_t s_pcm_read = 0;
  static uint8_t s_pcm_write = 0;
  static uint8_t s_pcm_queued = 0;
  static bool s_sentence_end_pending = false;
  static uint32_t s_pending_offset = 0;           
  static bool s_ignore_audio = false;           

  static const int16_t stepTable[89] = {
    7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,
    34,37,41,45,50,55,60,66,73,80,88,97,107,118,
    130,143,157,173,190,209,230,253,279,307,337,
    371,408,449,494,544,598,658,724,796,876,963,
    1060,1166,1282,1411,1552,1707,1878,2066,2272,
    2499,2749,3024,3327,3660,4026,4428,4871,5358,
    5894,6484,7132,7845,8630,9493,10442,11487,
    12635,13899,15289,16818,18500,20350,22385,
    24623,27086,29794,32767
  };

  static const int8_t indexTable[16] = {
    -1,-1,-1,-1,2,4,6,8,
    -1,-1,-1,-1,2,4,6,8
  };

  static int32_t s_adpcm_valpred = 0;           
  static int32_t s_adpcm_index = 0;             
#endif

// =========================================================================
// SECTION 4: FUNCTION PROTOTYPES & FORWARD DECLARATIONS
// =========================================================================

static void set_ui_state(UIState state);       
static void window_click_config_provider(void *context);
static void conversation_disable(void);
static void conversation_schedule_resume(void);
#if HA_MIC_AVAILABLE
static void native_mic_start(void);
static void native_mic_disable(void);
#endif 
#ifdef PBL_SPEAKER
  static void up_volume_handler(ClickRecognizerRef recognizer, void *context);   
  static void down_volume_handler(ClickRecognizerRef recognizer, void *context); 
#endif

// =========================================================================
// SECTION 5: SPLASH GRAPHICS & PROCESSING DRAW VECTORS
// =========================================================================

static void pinwheel_timer_callback(void *data) {
  s_pinwheel_timer = NULL;                      
  s_pinwheel_angle = (s_pinwheel_angle + 30) % 360; 
  layer_mark_dirty(s_pinwheel_layer);           
  if (s_current_state == UI_STATE_THINKING) {    
    s_pinwheel_timer = app_timer_register(100, pinwheel_timer_callback, NULL); 
  }
}

static void pinwheel_update_proc(Layer *layer, GContext *ctx) {
  if (s_current_state != UI_STATE_THINKING) return; 
  GRect bounds = layer_get_bounds(layer);        
  GPoint center = grect_center_point(&bounds);  
  int radius = 9;                               
  graphics_context_set_stroke_color(ctx, GColorBlack); 
  graphics_context_set_stroke_width(ctx, 3);    
  for(int i = 0; i < 4; i++) {                  
     int32_t angle = TRIG_MAX_ANGLE * (s_pinwheel_angle + i * 90) / 360; 
     int y = -cos_lookup(angle) * radius / TRIG_MAX_RATIO + center.y;   
     int x = sin_lookup(angle) * radius / TRIG_MAX_RATIO + center.x;     
     graphics_draw_line(ctx, center, GPoint(x, y));                     
  }
}

static void arrow_update_proc(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);        
  graphics_context_set_stroke_color(ctx, GColorBlack); 
  graphics_context_set_stroke_width(ctx, 3);    
  int y = bounds.size.h / 2;                    
  int x_start = 0;                              
  int x_end = bounds.size.w - 5;                
  graphics_draw_line(ctx, GPoint(x_start, y), GPoint(x_end, y));         
  graphics_draw_line(ctx, GPoint(x_end, y), GPoint(x_end - 6, y - 6));   
  graphics_draw_line(ctx, GPoint(x_end, y), GPoint(x_end - 6, y + 6));   
}

static void ha_haptic(void) {
  if (s_haptic_level == 1) vibes_short_pulse();
  else if (s_haptic_level == 2) vibes_double_pulse();
  else if (s_haptic_level >= 3) vibes_long_pulse();
}

static void set_status(const char* status) {
  if (status == NULL) {                         
    layer_set_hidden(text_layer_get_layer(s_status_layer), true); 
  } else {
    text_layer_set_text(s_status_layer, status); 
    layer_set_hidden(text_layer_get_layer(s_status_layer), false); 
  }
}

static void update_text_layout() {
  Layer *window_layer = window_get_root_layer(s_main_window); 
  int16_t screen_width = layer_get_bounds(window_layer).size.w; 
  int16_t text_width = screen_width - 10;       
  text_layer_set_size(s_text_layer, GSize(text_width, 2000)); 
  GSize max_size = text_layer_get_content_size(s_text_layer); 
  max_size.h += 30;                             
  text_layer_set_size(s_text_layer, max_size);  
  scroll_layer_set_content_size(s_scroll_layer, GSize(screen_width, max_size.h + 10)); 
}

// =========================================================================
// SECTION 6: IMA-ADPCM DECODER & HARDWARE SPEAKER MANAGEMENT (SPEAKER ONLY)
// =========================================================================

#ifdef PBL_SPEAKER
  static void reset_adpcm_state() {
    s_adpcm_valpred = 0;                        
    s_adpcm_index = 0;                          
  }

  static int16_t decode_adpcm_to_16bit(uint8_t delta) {
    int32_t step = stepTable[s_adpcm_index];     
    int32_t vpdiff = step >> 3;                 

    if (delta & 4) vpdiff += step;
    if (delta & 2) vpdiff += (step >> 1);
    if (delta & 1) vpdiff += (step >> 2);

    if (delta & 8) s_adpcm_valpred -= vpdiff;
    else s_adpcm_valpred += vpdiff;

    if (s_adpcm_valpred > 32767) s_adpcm_valpred = 32767;
    if (s_adpcm_valpred < -32768) s_adpcm_valpred = -32768;

    s_adpcm_index += indexTable[delta];
    if (s_adpcm_index < 0) s_adpcm_index = 0;     
    if (s_adpcm_index > 88) s_adpcm_index = 88;   

    return (int16_t)(s_adpcm_valpred * s_volume);
  }

  static void hide_volume_layer_callback(void *data) {
    s_volume_timer = NULL;                      
    layer_set_hidden(text_layer_get_layer(s_volume_text_layer), true); 
  }

  static void show_volume_indicator() {
    static char vol_buf[16];                    
    int percentage = (int)(s_volume * 100.0f + 0.5f); 
    if (percentage > 100) percentage = 100;     
    if (percentage < 0) percentage = 0;         

    snprintf(vol_buf, sizeof(vol_buf), "Vol: %d%%", percentage); 
    text_layer_set_text(s_volume_text_layer, vol_buf); 
    layer_set_hidden(text_layer_get_layer(s_volume_text_layer), false); 

    if (s_volume_timer) app_timer_cancel(s_volume_timer); 
    s_volume_timer = app_timer_register(2000, hide_volume_layer_callback, NULL); 
  }

  static void playback_timer_callback(void *data); 
  static void delayed_close_callback(void *data);  

  static void cancel_close_timer() {
    if (s_stream_close_timer) {
      app_timer_cancel(s_stream_close_timer);   
      s_stream_close_timer = NULL;              
    }
  }

  static void schedule_close_timer() {
    if (!s_stream_close_timer) {
      s_stream_close_timer = app_timer_register(STREAM_CLOSE_DELAY_MS, delayed_close_callback, NULL); 
    }
  }

  static void delayed_close_callback(void *data) {
    s_stream_close_timer = NULL;                
    if (s_buffer_count == 0 && s_pcm_queued == 0 && s_speaker_open) { 
      speaker_stream_close();                   
      s_speaker_open = false;
      if(s_conversation_audio_complete){
        s_conversation_audio_complete=false;
        conversation_schedule_resume();
      }
    }
  }

  static void stop_audio(void);
  static void push_to_ring_buffer(uint8_t *data, uint16_t length) {
    // ADPCM has a stateful predictor. Dropping a single byte silently
    // desynchronizes the entire remaining speech stream into noise.
    if (length > RING_BUFFER_SIZE - s_buffer_count) {
      APP_LOG(APP_LOG_LEVEL_ERROR,
        "ADPCM ring overflow: queued=%lu incoming=%u capacity=%u",
        (unsigned long)s_buffer_count, (unsigned)length, RING_BUFFER_SIZE);
      stop_audio();
      s_ignore_audio = true;
      set_status("Audio overflow");
      return;
    }
    for (uint16_t i = 0; i < length; i++) {
      s_ring_buffer[s_tail] = data[i];
      s_tail = (s_tail + 1) % RING_BUFFER_SIZE;
      s_buffer_count++;
    }
    cancel_close_timer();
  }

  static void start_playback() {
    cancel_close_timer();                       
    set_status(NULL);                           

    if (!s_speaker_open) {                      
      bool success = speaker_stream_open(SpeakerPcmFormat_8kHz_16bit, 100);
      if (!success) {
        APP_LOG(APP_LOG_LEVEL_ERROR, "Speaker failed to open"); 
        return;
      }
      s_speaker_open = true;                    
    }

    if (!s_playback_timer) {                     
      s_playback_timer = app_timer_register(PLAYBACK_INTERVAL_MS, playback_timer_callback, NULL); 
    }
  }

  // Decode ahead into the free PCM frame without writing to the speaker.
  // Each 800 ADPCM bytes produces 200 ms of 8 kHz/16-bit PCM. A second
  // buffer absorbs BLE callback jitter while the first frame is playing.
  static void fill_pcm_frames(void) {
    // Wait for a complete 200 ms frame to avoid repeatedly starving the
    // speaker. Only decode a shorter final frame after sentence-end.
    while (s_pcm_queued < 2 &&
          (s_buffer_count >= PLAYBACK_ADPCM_BYTES ||
           (s_sentence_end_pending && s_buffer_count > 0))) {
      uint8_t slot = s_pcm_write;
      uint16_t count = s_buffer_count < PLAYBACK_ADPCM_BYTES ?
                         s_buffer_count : PLAYBACK_ADPCM_BYTES;
      if(count<PLAYBACK_ADPCM_BYTES)s_sentence_end_pending=false;
      for(uint16_t i=0;i<count;i++){
        uint8_t value=s_ring_buffer[s_head];
        s_head=(s_head+1)%RING_BUFFER_SIZE;
        s_buffer_count--;
        s_pcm_frames[slot][i*2]=decode_adpcm_to_16bit((value>>4)&15);
        s_pcm_frames[slot][i*2+1]=decode_adpcm_to_16bit(value&15);
      }
      s_pcm_lengths[slot]=(uint32_t)count*4;
      s_pcm_write^=1;
      s_pcm_queued++;
      // An exact multiple of frame size can finish without a short frame.
      // Do not apply that sentence-end flag to the next spoken sentence.
      if(s_buffer_count==0 && s_sentence_end_pending)
        s_sentence_end_pending=false;
    }
  }

  static void playback_timer_callback(void *data) {
    s_playback_timer=NULL;
    if(!s_speaker_open)return;
    // Preserve any partially accepted PCM. Decode into the alternate frame
    // and never overwrite a frame until the speaker accepts all its bytes.
    fill_pcm_frames();
    if(s_pcm_queued==0){
      schedule_close_timer();
      s_playback_timer=app_timer_register(20,playback_timer_callback,NULL);
      return;
    }
    cancel_close_timer();
    uint8_t slot=s_pcm_read;
    uint32_t remaining=s_pcm_lengths[slot]-s_pending_offset;
    uint32_t accepted=speaker_stream_write(
      ((uint8_t*)s_pcm_frames[slot])+s_pending_offset,remaining);
    if(accepted>remaining)accepted=remaining;
    s_pending_offset+=accepted;
    if(s_pending_offset<s_pcm_lengths[slot]){
      s_playback_timer=app_timer_register(15,playback_timer_callback,NULL);
      return;
    }
    s_pcm_lengths[slot]=0;
    s_pending_offset=0;
    s_pcm_read^=1;
    s_pcm_queued--;
    fill_pcm_frames();
    // Pace full 200 ms frames to real-time playback; the short retry timer
    // above is exclusively for a partial speaker write.
    s_playback_timer=app_timer_register(PLAYBACK_INTERVAL_MS,
                                        playback_timer_callback,NULL);
  }

  static void stop_audio() {
    if (s_speaker_open) {
      speaker_stream_close();                   
      s_speaker_open = false;                   
    }
    if (s_playback_timer) {
      app_timer_cancel(s_playback_timer);       
      s_playback_timer = NULL;                  
    }
    cancel_close_timer();                       
    s_buffer_count = 0;                         
    s_head = 0;                                 
    s_tail = 0;                                 
    reset_adpcm_state();                        
    s_pending_offset = 0;
    s_pcm_read = 0;
    s_pcm_write = 0;
    s_pcm_queued = 0;
    s_sentence_end_pending = false;
    s_pcm_lengths[0] = 0;
    s_pcm_lengths[1] = 0;
    set_status(NULL);                           
  }

  static void up_volume_handler(ClickRecognizerRef recognizer, void *context) {
    s_volume += 0.1f;                           
    if (s_volume > 1.0f) s_volume = 1.0f;       
    persist_write_int(PERSIST_KEY_VOLUME, (int)(s_volume * 100.0f + 0.5f)); 
    ha_haptic();
    show_volume_indicator();                    
  }

  static void down_volume_handler(ClickRecognizerRef recognizer, void *context) {
    s_volume -= 0.1f;                           
    if (s_volume < 0.0f) s_volume = 0.0f;       
    persist_write_int(PERSIST_KEY_VOLUME, (int)(s_volume * 100.0f + 0.5f)); 
    ha_haptic();
    show_volume_indicator();                    
  }
#endif


#if HA_MIC_AVAILABLE
// SDK 110+ handles Speex compression and Bluetooth microphone transfer.
// The phone delivers decoded PCM16 via audiostream events.
static bool s_native_streaming = false;
static bool s_native_waiting = false;
static bool s_native_phone_accepted = false;
static const char *native_stop_reason_name(MicStreamStopReason reason) {
  switch (reason) {
    case MicStreamStopReasonStopped: return "Stopped";
    case MicStreamStopReasonFocusLost: return "FocusLost";
    case MicStreamStopReasonInterrupted: return "Interrupted";
    case MicStreamStopReasonPhone: return "Phone";
    case MicStreamStopReasonError: return "Error";
    default: return "Unknown";
  }
}
static void native_send_command(const char *command) {
  DictionaryIterator *iter = NULL;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK || !iter) return;
  dict_write_cstring(iter, MESSAGE_KEY_COMMAND, command);
  app_message_outbox_send();
}
static void native_mic_stop(void) {
  if (s_native_streaming || mic_stream_to_phone_is_active()) {
    s_native_streaming = false;
    mic_stream_to_phone_stop();
  }
}
static void native_mic_started(void *context) {
  s_native_phone_accepted = true;
  APP_LOG(APP_LOG_LEVEL_INFO, "Native mic: phone accepted audio stream");
  if (s_conversation_mode && !s_native_waiting) set_status("Listening...");
}
static void native_mic_stopped(MicStreamStopReason reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Native mic stopped: reason=%s (%d), accepted=%d, waiting=%d",
          native_stop_reason_name(reason), (int)reason,
          (int)s_native_phone_accepted, (int)s_native_waiting);
  s_native_streaming = false;
  // Expected stop at the end of an utterance; don't cancel conversation.
  if (s_native_waiting || !s_conversation_mode) return;
  s_native_waiting = true;
  s_conversation_mode = false;
  native_send_command("MIC_MODE_OFF");
  set_ui_state(UI_STATE_IDLE);
  if (reason == MicStreamStopReasonPhone) {
    set_status(s_native_phone_accepted ? "Phone ended mic stream" :
                 "Phone refused mic; check permission");
  } else if (reason == MicStreamStopReasonFocusLost) {
    set_status("Mic stopped: app lost focus");
  } else if (reason == MicStreamStopReasonInterrupted) {
    set_status("Mic busy: system interruption");
  } else if (reason == MicStreamStopReasonError) {
    set_status("Mic stream system error");
  } else {
    set_status("Mic stopped unexpectedly");
  }
  ha_haptic();
}
static void native_mic_start(void) {
  if (!s_conversation_mode || s_native_streaming) return;
  s_native_waiting = false;
  s_native_phone_accepted = false;
  s_thinking_transcript[0] = 0;
  if (s_thinking_transcript_layer)
    text_layer_set_text(s_thinking_transcript_layer, s_thinking_transcript);
  set_ui_state(UI_STATE_IDLE);
  MicStreamStartResult result = mic_stream_to_phone_start((MicStreamHandlers){
    .started = native_mic_started, .stopped = native_mic_stopped
  }, NULL);
  s_native_streaming = result == MicStreamStartOk;
  APP_LOG(APP_LOG_LEVEL_INFO, "Native mic start returned %d", (int)result);
  if (!s_native_streaming) {
    s_conversation_mode = false; s_native_waiting = true;
    native_send_command("MIC_MODE_OFF");
    set_ui_state(UI_STATE_IDLE);
    set_status(result == MicStreamStartErrBusy ? "Microphone busy" :
               result == MicStreamStartErrUnavailable ? "Microphone unavailable" :
               result == MicStreamStartErrNotForeground ? "App not foreground" :
               "Mic denied or unavailable");
    ha_haptic();
  } else set_status("Listening...");
}
static void native_mic_disable(void) {
  if (!s_conversation_mode) return;
  s_conversation_mode = false; s_native_waiting = true;
  native_mic_stop();
  native_send_command("MIC_MODE_OFF");
#ifdef PBL_SPEAKER
  s_conversation_audio_complete = false;
#endif
}
static void native_mic_toggle(void) {
  if (s_conversation_mode) {
    native_mic_disable();
    set_ui_state(UI_STATE_IDLE);
    set_status(NULL);
    ha_haptic();
    return;
  }
#ifdef PBL_SPEAKER
  s_ignore_audio = true;
  stop_audio();
#endif
  s_conversation_mode = true; s_native_waiting = false;
  native_send_command("MIC_MODE_ON");
  native_mic_start();
  ha_haptic();
}
#endif

// Legacy SDK fallback: dictation produces recognized text, not raw PCM.
// Reopen Pebble's dictation UI after each Home Assistant answer finishes.
// Back on the Pebble dictation overlay is delivered as a rejected transcription;
// this must end conversation mode and clear the status rather than implying
// that the microphone is still recording.
static void conversation_resume_callback(void *context) {
  s_conversation_resume_timer = NULL;
  if (!s_conversation_mode || !s_dictation_fallback || s_conversation_dictating) return;
  if (!s_dictation_session) {
    conversation_disable();
    set_status("Dictation unavailable");
    return;
  }
  set_ui_state(UI_STATE_IDLE);
  set_status("Conversation: dictation");
  s_conversation_dictating = true;
  DictationSessionStatus result = dictation_session_start(s_dictation_session);
  if (result != DictationSessionStatusSuccess) {
    s_conversation_dictating = false;
    conversation_disable();
    set_status("Unable to restart dictation");
    ha_haptic();
  }
}
static void conversation_schedule_resume(void) {
  if (!s_conversation_mode) return;
#if HA_MIC_AVAILABLE
  if (!s_dictation_fallback) { native_mic_start(); return; }
#endif
  if (s_conversation_resume_timer) app_timer_cancel(s_conversation_resume_timer);
  s_conversation_resume_timer = app_timer_register(450, conversation_resume_callback, NULL);
}
static void conversation_disable(void) {
  if (s_conversation_resume_timer) {
    app_timer_cancel(s_conversation_resume_timer);
    s_conversation_resume_timer = NULL;
  }
  s_conversation_audio_complete = false;
  if (s_conversation_dictating && s_dictation_session) {
    // Back/Select during a dictation turn must stop the modal voice UI too.
    // Pebble will not call our result handler after an explicit stop.
    dictation_session_stop(s_dictation_session);
  }
  s_conversation_dictating = false;
#if HA_MIC_AVAILABLE
  if (s_conversation_mode && !s_dictation_fallback) native_mic_disable();
#endif
  s_conversation_mode = false;
  s_dictation_fallback = false;
  // Do not leave a stale "listening" claim visible after a cancelled turn.
  set_status(NULL);
}
static void conversation_toggle(void) {
  if (s_conversation_mode) {
    conversation_disable();
    set_ui_state(UI_STATE_IDLE);
    set_status(NULL);
    ha_haptic();
    return;
  }
#ifdef PBL_SPEAKER
  s_ignore_audio = true;
  stop_audio();
#endif
#if HA_MIC_AVAILABLE
  native_mic_toggle();
#else
  // Other platforms retain one-shot dictation rather than claim hands-free.
  set_status("Continuous microphone unavailable");
  ha_haptic();
#endif
}

// =========================================================================
// SECTION 7: HARDWARE KEY BOARD REGISTRATION & INTERCEPT MAPPINGS
// =========================================================================

static void select_short_click_handler(ClickRecognizerRef recognizer, void *context) {
  #ifdef PBL_SPEAKER
  if (s_speaker_open || s_buffer_count > 0 || !s_ignore_audio) {
    s_ignore_audio = true;                      
    stop_audio();                               
  }
  #endif
#if HA_MIC_AVAILABLE
  // While in hands-free conversation, a short Select ends only this spoken
  // request. Do not leave conversation mode or open the system dictation UI.
  if (s_conversation_mode && !s_dictation_fallback) {
    if (!s_native_waiting && s_native_streaming) {
      s_native_waiting = true;
      native_mic_stop();
      set_ui_state(UI_STATE_THINKING);
      set_status("Processing speech...");
    }
    return;
  }
#endif
  if(s_conversation_mode) conversation_disable();
  set_status(NULL);
  if (!s_dictation_session) {
    set_status("Microphone unavailable");
    ha_haptic();
    return;
  }
  DictationSessionStatus result = dictation_session_start(s_dictation_session);
  if (result != DictationSessionStatusSuccess) {
    set_status("Unable to start dictation");
    ha_haptic();
  }
}

static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  conversation_toggle();
}

// The Back button returns from results to the idle screen; at idle the
// default Pebble Back action remains active and exits the application.
static void exit_back_click_handler(ClickRecognizerRef recognizer, void *context) {
  if (s_conversation_mode) {
    conversation_disable();
    set_ui_state(UI_STATE_IDLE);
    set_status(NULL);
    return;
  }
  if (s_current_state == UI_STATE_THINKING) {
#if HA_MIC_AVAILABLE
    native_send_command("MIC_MODE_OFF");
#endif
    set_ui_state(UI_STATE_IDLE);
    return;
  }
  window_stack_pop(true);
}

static void results_back_click_handler(ClickRecognizerRef recognizer, void *context) {
  #ifdef PBL_SPEAKER
    s_ignore_audio = true;
    stop_audio();
  #endif
  conversation_disable();
  set_status(NULL);
  set_ui_state(UI_STATE_IDLE);
}

static void window_click_config_provider(void *context) {
  if (s_current_state == UI_STATE_RESULTS) {    
    window_single_click_subscribe(BUTTON_ID_BACK, results_back_click_handler);
    window_set_click_context(BUTTON_ID_UP, s_scroll_layer); 
    window_set_click_context(BUTTON_ID_DOWN, s_scroll_layer);

    window_single_repeating_click_subscribe(BUTTON_ID_UP, 100, (ClickHandler) scroll_layer_scroll_up_click_handler);
    window_single_repeating_click_subscribe(BUTTON_ID_DOWN, 100, (ClickHandler) scroll_layer_scroll_down_click_handler);
    
    window_single_click_subscribe(BUTTON_ID_SELECT, select_short_click_handler);
    window_long_click_subscribe(BUTTON_ID_SELECT, 500, select_long_click_handler, NULL); 
 
    
    #ifdef PBL_SPEAKER
      window_long_click_subscribe(BUTTON_ID_UP, 500, up_volume_handler, NULL);
      window_long_click_subscribe(BUTTON_ID_DOWN, 500, down_volume_handler, NULL);
    #endif
  } else {
    window_single_click_subscribe(BUTTON_ID_BACK, exit_back_click_handler);
    window_single_click_subscribe(BUTTON_ID_SELECT, select_short_click_handler);
    window_long_click_subscribe(BUTTON_ID_SELECT, 500, select_long_click_handler, NULL); 
 
    
    #ifdef PBL_SPEAKER
      window_single_click_subscribe(BUTTON_ID_UP, up_volume_handler);    
      window_single_click_subscribe(BUTTON_ID_DOWN, down_volume_handler);  
    #endif
  }
}

// =========================================================================
// SECTION 8: STATE ROUTING ENGINE
// =========================================================================

static void set_ui_state(UIState state) {
  s_current_state = state;                      
  
  window_set_click_config_provider(s_main_window, window_click_config_provider);

  switch (state) {
    case UI_STATE_IDLE:                         
      layer_set_hidden(s_idle_layer, false);
      if (s_thinking_transcript_layer)
        layer_set_hidden(text_layer_get_layer(s_thinking_transcript_layer), true);
      layer_set_hidden(scroll_layer_get_layer(s_scroll_layer), true);
      layer_set_hidden(s_arrow_layer, false);   
      layer_set_hidden(s_pinwheel_layer, true);  
      text_layer_set_text(s_prompt_layer,
        s_conversation_mode ?
          (s_dictation_fallback ? "Conversation\nDictation mode" :
                                  "Conversation\nListening...") :
          "Press Select\nto record"); 
      break;
    case UI_STATE_THINKING:                     
      layer_set_hidden(s_idle_layer, false);    
      layer_set_hidden(scroll_layer_get_layer(s_scroll_layer), true); 
      layer_set_hidden(s_arrow_layer, true);    
      layer_set_hidden(s_pinwheel_layer, false); 
      text_layer_set_text(s_prompt_layer, "Thinking...");
      if (s_thinking_transcript_layer)
        layer_set_hidden(text_layer_get_layer(s_thinking_transcript_layer), false); 
      if (!s_pinwheel_timer) {                   
        s_pinwheel_timer = app_timer_register(100, pinwheel_timer_callback, NULL); 
      }
      break;
    case UI_STATE_RESULTS:                      
      layer_set_hidden(s_idle_layer, true);
      if (s_thinking_transcript_layer)
        layer_set_hidden(text_layer_get_layer(s_thinking_transcript_layer), true);
      layer_set_hidden(scroll_layer_get_layer(s_scroll_layer), false); 
      if (s_pinwheel_timer) {                   
        app_timer_cancel(s_pinwheel_timer);     
        s_pinwheel_timer = NULL;                
      }
      break;
  }
}

// =========================================================================
// SECTION 9: APP MESSAGE COMMUNICATIONS RECEIVER & PARSING STRUCTURES
// =========================================================================

static void inbox_received_callback(DictionaryIterator *iterator, void *context) {
  Tuple *command_tuple = dict_find(iterator, MESSAGE_KEY_COMMAND); 
  if (!command_tuple) return;                   

  if (strncmp(command_tuple->value->cstring, "TEXT_RESPONSE", 13) == 0) {
    #if HA_MIC_AVAILABLE
      if(s_conversation_mode) {s_native_waiting=true;native_mic_stop();}
    #endif 
    #ifdef PBL_SPEAKER
    bool no_audio = false;
      // MULTIPLEXING INTERCEPT: Determine if the phone told us to expect audio chunks
      if (strcmp(command_tuple->value->cstring, "TEXT_RESPONSE_NO_AUDIO") == 0) {
        no_audio = true;
        s_ignore_audio = true;
      }
    #endif

    Tuple *text_tuple = dict_find(iterator, MESSAGE_KEY_TEXT); 
    if (text_tuple) {
      snprintf(s_ha_text, sizeof(s_ha_text), "%s", text_tuple->value->cstring); 
      text_layer_set_text(s_text_layer, s_ha_text);
      update_text_layout();
      ha_haptic();                     
      
      set_ui_state(UI_STATE_RESULTS);          

      #ifdef PBL_SPEAKER
        if (no_audio) {
          set_status(NULL);                     // Immediately clear status strip if no audio is expected (text-only mode)
        } else {
          s_ignore_audio = false;               
          reset_adpcm_state();                  
          if (s_volume > 0.01f) {
            set_status("Buffering Audio...");   
          } else {
            set_status(NULL);                   
          }
        }
      #else
        set_status(NULL);                       
      #endif
    }
  } 
  
  #ifdef PBL_SPEAKER
  else if (strcmp(command_tuple->value->cstring, "AUDIO_CHUNK") == 0) { 
    if (s_ignore_audio) return;                 
    Tuple *chunk_tuple = dict_find(iterator, MESSAGE_KEY_CHUNK); 
    if (chunk_tuple) {
      push_to_ring_buffer(chunk_tuple->value->data, chunk_tuple->length); 
      if (!s_speaker_open && s_buffer_count >= START_BUFFER_THRESHOLD) start_playback();
    }
  } else if (strcmp(command_tuple->value->cstring, "AUDIO_SENTENCE_END") == 0) {
    if (s_ignore_audio) return;
    // There is no partial tail if the ring has already been decoded into
    // the two PCM frames. In that case, do not carry end-of-sentence state
    // into the next packet from the following sentence.
    s_sentence_end_pending=(s_buffer_count>0);
    if (!s_speaker_open && s_buffer_count > 0) start_playback();
  } 
  #endif
  
  else if(strcmp(command_tuple->value->cstring,"CONV_RESUME")==0) {
    if(s_conversation_mode) conversation_schedule_resume();
  }
  else if(strcmp(command_tuple->value->cstring,"CONV_AUDIO_END")==0) {
    // The BLE sender completed; do not listen until speaker buffer drains.
    if(s_conversation_mode) {
#ifdef PBL_SPEAKER
      if (s_ignore_audio || (!s_speaker_open && s_buffer_count == 0)) {
        conversation_schedule_resume();
      } else {
        s_conversation_audio_complete = true;
      }
#else
      conversation_schedule_resume();
#endif
    }
  }
    else if (strcmp(command_tuple->value->cstring, "SETTINGS") == 0) {
      Tuple *font_tuple = dict_find(iterator, MESSAGE_KEY_FONT_SIZE);
      Tuple *auto_tuple = dict_find(iterator, MESSAGE_KEY_AUTO_SEND);
      Tuple *haptic_tuple = dict_find(iterator, MESSAGE_KEY_HAPTIC_LEVEL);
      if (auto_tuple) s_auto_send = auto_tuple->value->int32 != 0;
      if (haptic_tuple) {
        s_haptic_level = haptic_tuple->value->int32;
        if (s_haptic_level < 0) s_haptic_level = 0;
        if (s_haptic_level > 3) s_haptic_level = 3;
      }
      if (s_dictation_session)
        dictation_session_enable_confirmation(s_dictation_session, !s_auto_send);
      if (font_tuple) {
        int new_size = font_tuple->value->int32;
        if (new_size <= 14) text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
        else if (new_size <= 18) text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
        else if (new_size <= 24) text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24));
        else text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28));
        update_text_layout();
      }
    }
    else if (strcmp(command_tuple->value->cstring, "HAPTIC_PREVIEW") == 0) {
      Tuple *haptic_tuple = dict_find(iterator, MESSAGE_KEY_HAPTIC_LEVEL);
      if (haptic_tuple) {
        s_haptic_level = haptic_tuple->value->int32;
        if (s_haptic_level < 0) s_haptic_level = 0;
        if (s_haptic_level > 3) s_haptic_level = 3;
      }
      ha_haptic();
    }
    else if (strcmp(command_tuple->value->cstring, "CONV_MODE_STOP") == 0) {
      conversation_disable();
      set_ui_state(UI_STATE_IDLE);
      set_status("Conversation stopped");
    }
    else if (strcmp(command_tuple->value->cstring, "MIC_MODE_OFF") == 0) {
#if HA_MIC_AVAILABLE
      native_mic_disable();
      set_ui_state(UI_STATE_IDLE);
      set_status("Microphone stream ended");
#endif
    }
    else if (strcmp(command_tuple->value->cstring, "MIC_TURN_END") == 0) {
#if HA_MIC_AVAILABLE
      if (s_conversation_mode) {
        s_native_waiting = true;
        native_mic_stop();
        set_ui_state(UI_STATE_THINKING);
        set_status("Processing speech...");
      }
#endif
    }
    else if (strcmp(command_tuple->value->cstring, "CONV_TRANSCRIPT") == 0) {
      Tuple *utterance = dict_find(iterator, MESSAGE_KEY_TEXT);
      if (utterance && s_thinking_transcript_layer) {
        snprintf(s_thinking_transcript, sizeof(s_thinking_transcript),
                 "You said:\n%.220s", utterance->value->cstring);
        text_layer_set_text(s_thinking_transcript_layer, s_thinking_transcript);
      }
    }
    else if (strcmp(command_tuple->value->cstring, "UPDATE_FONT") == 0) { 
    Tuple *font_tuple = dict_find(iterator, MESSAGE_KEY_FONT_SIZE); 
    if (font_tuple) {
      int new_size = font_tuple->value->int32;   
      if (new_size <= 14) text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
      else if (new_size <= 18) text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
      else if (new_size <= 24) text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24));
      else text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28));
      update_text_layout();                     
    }
  }
}

static void dictation_session_callback(DictationSession *session, DictationSessionStatus status, char *transcription, void *context) {
  s_conversation_dictating = false;
  if (status == DictationSessionStatusSuccess && transcription && transcription[0]) {
    snprintf(s_thinking_transcript, sizeof(s_thinking_transcript),
             "You said:\n%.220s", transcription);
    if (s_thinking_transcript_layer)
      text_layer_set_text(s_thinking_transcript_layer, s_thinking_transcript);
    ha_haptic();
    set_ui_state(UI_STATE_THINKING);
    text_layer_set_text(s_text_layer, "");      
    update_text_layout();                       

    DictionaryIterator *iter = NULL;
    AppMessageResult outbox_result = app_message_outbox_begin(&iter);
    if (outbox_result != APP_MSG_OK || !iter) {
      if (s_conversation_mode) conversation_disable();
      set_ui_state(UI_STATE_IDLE);
      set_status("Phone message queue busy");
      ha_haptic();
      return;
    }
    dict_write_cstring(iter, MESSAGE_KEY_COMMAND,
                       s_conversation_mode && s_dictation_fallback ?
                       "CONV_DICTATION" : "DICTATION"); 
    dict_write_cstring(iter, MESSAGE_KEY_TEXT, transcription);  
    
    #ifdef PBL_SPEAKER
      dict_write_int32(iter, MESSAGE_KEY_VOLUME, (int)(s_volume * 100.0f + 0.5f)); 
    #else
      dict_write_int32(iter, MESSAGE_KEY_VOLUME, 0); 
    #endif
    
    if (app_message_outbox_send() != APP_MSG_OK) {
      if (s_conversation_mode) conversation_disable();
      set_ui_state(UI_STATE_IDLE);
      set_status("Could not send to phone");
      ha_haptic();
    }
  } else {
    bool cancelled = status == DictationSessionStatusFailureTranscriptionRejected ||
                     status == DictationSessionStatusFailureTranscriptionRejectedWithError;
    if (s_conversation_mode && s_dictation_fallback) conversation_disable();
    set_ui_state(UI_STATE_IDLE);
    set_status(NULL);
    if (!cancelled) {
      const char *reason = "Speech recognition failed";
      if (status == DictationSessionStatusFailureNoSpeechDetected) reason = "No speech detected";
      else if (status == DictationSessionStatusFailureConnectivityError) reason = "Speech: check phone connection";
      else if (status == DictationSessionStatusFailureDisabled) reason = "Dictation disabled on phone";
      else if (status == DictationSessionStatusFailureRecognizerError) reason = "Speech recognition unavailable";
      set_status(reason);
      ha_haptic();
    }
  }
}

// =========================================================================
// SECTION 10: PRIMARY UI CANVAS STRUCT DESIGN LOADING MODULES
// =========================================================================

static void main_window_load(Window *window) {
  window_set_background_color(window, GColorWhite); 
  Layer *window_layer = window_get_root_layer(window); 
  GRect bounds = layer_get_bounds(window_layer); 

  s_scroll_layer = scroll_layer_create(bounds);
  layer_add_child(window_layer, scroll_layer_get_layer(s_scroll_layer)); 

  s_text_layer = text_layer_create(GRect(5, 5, bounds.size.w - 10, 2000));
  text_layer_set_text_alignment(s_text_layer, GTextAlignmentLeft);
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24));

  #if defined(PBL_ROUND) 
    text_layer_enable_screen_text_flow_and_paging(s_text_layer, 5); 
  #endif

  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_text_layer)); 

  s_status_layer = text_layer_create(GRect(0, bounds.size.h - 24, bounds.size.w, 24));
  text_layer_set_background_color(s_status_layer, GColorBlack);
  text_layer_set_text_color(s_status_layer, GColorWhite);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  layer_set_hidden(text_layer_get_layer(s_status_layer), true); 
  layer_add_child(window_layer, text_layer_get_layer(s_status_layer));

  s_idle_layer = layer_create(bounds);

  #if defined(PBL_ROUND) 
    s_logo_layer = bitmap_layer_create(GRect((bounds.size.w / 2) - 24, 15, 48, 48));
    s_title_layer = text_layer_create(GRect(0, 61, bounds.size.w, 52));
    text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter); 

    s_prompt_layer = text_layer_create(GRect(10, 119, bounds.size.w - 20, 52));
    text_layer_set_text_alignment(s_prompt_layer, GTextAlignmentCenter); 

    s_arrow_layer = layer_create(GRect(bounds.size.w - 30, 110, 20, 20));
    s_pinwheel_layer = layer_create(GRect(bounds.size.w - 35, 105, 30, 30));
  #else 
    s_logo_layer = bitmap_layer_create(GRect(10, 15, 48, 48));
    s_title_layer = text_layer_create(GRect(65, 19, bounds.size.w - 67, 52));
    text_layer_set_text_alignment(s_title_layer, GTextAlignmentLeft); 

    s_prompt_layer = text_layer_create(GRect(5, 94, bounds.size.w - 64, 44));
    text_layer_set_text_alignment(s_prompt_layer, GTextAlignmentRight); 

    s_arrow_layer = layer_create(GRect(bounds.size.w - 25, 95, 25, 20));
    s_pinwheel_layer = layer_create(GRect(bounds.size.w - 30, 90, 30, 30));
  #endif

 

  // Same idle-screen bitmap layout as Pebble Gemini, now using Home Assistant.
  s_logo_bitmap = gbitmap_create_with_resource(RESOURCE_ID_IMAGE_HOME_ASSISTANT_LOGO);
  if (s_logo_bitmap) {
    bitmap_layer_set_bitmap(s_logo_layer, s_logo_bitmap);
    bitmap_layer_set_compositing_mode(s_logo_layer, GCompOpSet);
  }
  layer_add_child(s_idle_layer, bitmap_layer_get_layer(s_logo_layer));

  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_text(s_title_layer, "Home\nAssistant AI");
  layer_add_child(s_idle_layer, text_layer_get_layer(s_title_layer));

  text_layer_set_font(s_prompt_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24));
  text_layer_set_text(s_prompt_layer, "Press Select\nto record");
  layer_add_child(s_idle_layer, text_layer_get_layer(s_prompt_layer));

  s_thinking_transcript_layer = text_layer_create(
      GRect(8, bounds.size.h - 79, bounds.size.w - 18, 74));
  text_layer_set_font(s_thinking_transcript_layer,
                      fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_color(s_thinking_transcript_layer, GColorBlack);
  text_layer_set_background_color(s_thinking_transcript_layer, GColorClear);
  text_layer_set_text(s_thinking_transcript_layer, "");
  layer_set_hidden(text_layer_get_layer(s_thinking_transcript_layer), true);
  layer_add_child(s_idle_layer, text_layer_get_layer(s_thinking_transcript_layer));

#ifdef PBL_SPEAKER
  // On the home screen, identify the right-side Up/Down volume buttons.
  // Labels live inside the idle layer so they disappear when results use
  // these buttons for scrolling (long-press Up/Down still changes volume).
  #if !defined(PBL_ROUND)
    s_volume_up_hint_layer = text_layer_create(
      GRect(bounds.size.w - 59, 23, 56, 24));
    s_volume_down_hint_layer = text_layer_create(
      GRect(bounds.size.w - 59, bounds.size.h - 53, 56, 24));
    TextLayer *volume_hints[] = {s_volume_up_hint_layer, s_volume_down_hint_layer};
    const char *volume_labels[] = {"Vol +", "Vol -"};
    for (int i = 0; i < 2; ++i) {
      text_layer_set_text(volume_hints[i], volume_labels[i]);
      text_layer_set_font(volume_hints[i], fonts_get_system_font(FONT_KEY_GOTHIC_18));
      text_layer_set_text_alignment(volume_hints[i], GTextAlignmentRight);
      text_layer_set_background_color(volume_hints[i], GColorClear);
      text_layer_set_text_color(volume_hints[i], GColorBlack);
      layer_add_child(s_idle_layer, text_layer_get_layer(volume_hints[i]));
    }
  #endif
#endif

  layer_set_update_proc(s_arrow_layer, arrow_update_proc); 
  layer_add_child(s_idle_layer, s_arrow_layer);

  layer_set_update_proc(s_pinwheel_layer, pinwheel_update_proc); 
  layer_add_child(s_idle_layer, s_pinwheel_layer);

  layer_add_child(window_layer, s_idle_layer); 

  #ifdef PBL_SPEAKER
    s_volume_text_layer = text_layer_create(GRect(bounds.size.w - 85, 5, 80, 24));
    text_layer_set_background_color(s_volume_text_layer, GColorBlack);
    text_layer_set_text_color(s_volume_text_layer, GColorWhite);
    text_layer_set_font(s_volume_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
    text_layer_set_text_alignment(s_volume_text_layer, GTextAlignmentCenter);
    layer_set_hidden(text_layer_get_layer(s_volume_text_layer), true); 
    layer_add_child(window_layer, text_layer_get_layer(s_volume_text_layer));
  #endif

  s_dictation_session = dictation_session_create(sizeof(s_ha_text), dictation_session_callback, NULL);
  if (s_dictation_session) {
    dictation_session_enable_confirmation(s_dictation_session, !s_auto_send);
    dictation_session_enable_error_dialogs(s_dictation_session, true);
  }

  set_ui_state(UI_STATE_IDLE); 
}

static void main_window_unload(Window *window) {
  conversation_disable();
  #ifdef PBL_SPEAKER
    stop_audio();                               
    if (s_volume_timer) app_timer_cancel(s_volume_timer); 
    text_layer_destroy(s_volume_text_layer);
    #if !defined(PBL_ROUND)
      text_layer_destroy(s_volume_up_hint_layer);
      text_layer_destroy(s_volume_down_hint_layer);
    #endif    
  #endif
  
  dictation_session_destroy(s_dictation_session);
  text_layer_destroy(s_thinking_transcript_layer);
  if (s_logo_bitmap) gbitmap_destroy(s_logo_bitmap);
  bitmap_layer_destroy(s_logo_layer); 
 
           
  text_layer_destroy(s_title_layer);            
  text_layer_destroy(s_prompt_layer);           
  layer_destroy(s_arrow_layer);                 
  layer_destroy(s_pinwheel_layer);              
  layer_destroy(s_idle_layer);                  
  text_layer_destroy(s_status_layer);           
  text_layer_destroy(s_text_layer);             
  scroll_layer_destroy(s_scroll_layer);         
}

// =========================================================================
// SECTION 11: MASTER INITIALIZATION & SYSTEM APPLICATION LIFE LOOPS ENTRY
// =========================================================================

static void init() {
  #ifdef PBL_SPEAKER
    if (persist_exists(PERSIST_KEY_VOLUME)) s_volume = persist_read_int(PERSIST_KEY_VOLUME) / 100.0f;
    else s_volume = 1.0f; 
  #endif
  
  app_message_register_inbox_received(inbox_received_callback);
#if HA_MIC_AVAILABLE
  // Microphone audio is handled natively by PebbleOS; no AppMessage PCM.
#endif 
  app_message_open(12000, 1024);                
  
  s_main_window = window_create();              
  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load = main_window_load, .unload = main_window_unload 
  });
  
  window_set_click_config_provider(s_main_window, window_click_config_provider);
  window_stack_push(s_main_window, true);       
}

static void deinit() { 
  window_destroy(s_main_window);                
}

int main(void) { 
  init();                                       
  app_event_loop();                             
  deinit();                                     
}