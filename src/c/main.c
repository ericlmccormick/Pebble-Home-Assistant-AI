// =========================================================================
// SECTION 1: SYSTEM HEADERS & PREPROCESSOR MACROS
// =========================================================================

#include <pebble.h>
// Uncomment ONLY with PebbleOS SDK revision >=111 and matching firmware:
// #define HA_ENABLE_RAW_MIC 1 

#define MAX_TEXT_LENGTH 2048
// Compile with -DHA_ENABLE_RAW_MIC only against PebbleOS SDK revision >=111
// and matching firmware. The CloudPebble 4.33.1 SDK lacks these exports.
#if defined(HA_ENABLE_RAW_MIC) && defined(PBL_MICROPHONE) && !defined(PBL_SDK_FROZEN)
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
#if HA_MIC_AVAILABLE && defined(PBL_SPEAKER)
static bool s_conversation_audio_complete=false;
#endif 
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
#if HA_MIC_AVAILABLE
static void ha_mic_restart(void);
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
    if (s_buffer_count == 0 && s_speaker_open) { 
      speaker_stream_close();                   
      s_speaker_open = false;
      #if HA_MIC_AVAILABLE
      if(s_conversation_audio_complete){s_conversation_audio_complete=false;ha_mic_restart();}
      #endif
    }
  }

  static void push_to_ring_buffer(uint8_t *data, uint16_t length) {
    for (uint16_t i = 0; i < length; i++) {     
      if (s_buffer_count < RING_BUFFER_SIZE) {  
        s_ring_buffer[s_tail] = data[i];        
        s_tail = (s_tail + 1) % RING_BUFFER_SIZE; 
        s_buffer_count++;                       
      }
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

  static void playback_timer_callback(void *data) {
    s_playback_timer = NULL;                    
    if (!s_speaker_open) return;                

    static int16_t s_out_buf[PLAYBACK_PCM_SAMPLES]; 

    if (s_buffer_count >= PLAYBACK_ADPCM_BYTES) { 
      for (int i = 0; i < PLAYBACK_ADPCM_BYTES; i++) { 
        uint8_t adpcm_byte = s_ring_buffer[s_head]; 
        s_head = (s_head + 1) % RING_BUFFER_SIZE; 
        s_buffer_count--;                       

        uint8_t nibble1 = (adpcm_byte >> 4) & 0x0F; 
        uint8_t nibble2 = adpcm_byte & 0x0F;        

        s_out_buf[i * 2] = decode_adpcm_to_16bit(nibble1);     
        s_out_buf[(i * 2) + 1] = decode_adpcm_to_16bit(nibble2); 
      }
      speaker_stream_write((uint8_t*)s_out_buf, sizeof(s_out_buf)); 
    } else {
      memset(s_out_buf, 0, sizeof(s_out_buf));
      speaker_stream_write((uint8_t*)s_out_buf, sizeof(s_out_buf)); 
      schedule_close_timer();                   
    }
    s_playback_timer = app_timer_register(PLAYBACK_INTERVAL_MS, playback_timer_callback, NULL);
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
// Raw microphone: 16 kHz, signed mono, 320 samples per 20-ms callback.
// Each frame is independently encoded as 4-bit IMA ADPCM for BLE transport.
// Avoid allocating memory or blocking in capture callbacks.
#define HA_SAMPLES_PER_FRAME 320
#define HA_FRAME_BYTES 160
#define HA_QUEUE_FRAMES 48
#define HA_PREROLL_FRAMES 10
#define HA_SILENCE_FRAMES 65
#define HA_MAX_FRAMES 1100
static uint8_t s_mic_queue[HA_QUEUE_FRAMES][HA_FRAME_BYTES];
static uint16_t s_mic_head = 0, s_mic_tail = 0, s_mic_count = 0;
static uint8_t s_preroll[HA_PREROLL_FRAMES][HA_FRAME_BYTES];
static uint8_t s_preroll_len=0, s_preroll_at=0;
static bool s_mic_capturing=false, s_mic_sending=false, s_mic_end_pending=false;
static bool s_mic_utterance=false, s_mic_waiting=false, s_mic_start_pending=false;
static bool s_mic_cancel_pending=false, s_mic_tx_busy=false, s_mic_overflow=false;
static uint32_t s_mic_seq=0;
static unsigned s_mic_silence=0, s_mic_frames=0, s_mic_speech_frames=0;
static int32_t s_mic_valpred=0, s_mic_index=0;
static const int16_t s_mic_steps[89]={
7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,
34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,
190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,
796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,
2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,
7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,
22385,24623,27086,29794,32767};
static const int8_t s_mic_indices[16]={-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8};
static void ha_mic_flush(void);
static void ha_mic_restart(void);

static void ha_mic_encode(const int16_t *samples,size_t count,uint8_t *out) {
  int32_t pred=0, idx=0;
  for(size_t i=0;i<HA_SAMPLES_PER_FRAME;i++) {
    int32_t sample=(i<count)?samples[i]:0;
    int32_t diff=sample-pred;
    uint8_t sign=diff<0?8:0;
    if(diff<0)diff=-diff;
    int32_t step=s_mic_steps[idx], vpdiff=step>>3;
    uint8_t d=0;
    if(diff>=step){d|=4;diff-=step;vpdiff+=step;}
    if(diff>=step/2){d|=2;diff-=step/2;vpdiff+=step/2;}
    if(diff>=step/4){d|=1;vpdiff+=step/4;}
    pred += sign?-vpdiff:vpdiff;
    if(pred>32767)pred=32767;
    if(pred< -32768)pred=-32768;
    d|=sign;
    idx+=s_mic_indices[d];if(idx<0)idx=0;if(idx>88)idx=88;
    if(!(i&1))out[i/2]=(uint8_t)(d<<4);
    else out[i/2]|=d;
  }
}
static void ha_mic_enqueue(const uint8_t *frame) {
  if(s_mic_count==HA_QUEUE_FRAMES) {s_mic_overflow=true;return;}
  memcpy(s_mic_queue[s_mic_tail],frame,HA_FRAME_BYTES);
  s_mic_tail=(s_mic_tail+1)%HA_QUEUE_FRAMES;
  s_mic_count++;
}
static void ha_mic_halt(void) {
  if(s_mic_capturing){s_mic_capturing=false;mic_capture_stop();}
}
static void ha_mic_finish(void) {
  ha_mic_halt();
  s_mic_end_pending=true;
  s_mic_waiting=true;
  set_status("Processing...");
  ha_mic_flush();
}
static void ha_mic_data(const int16_t *samples,size_t count,void *ctx) {
  if(!s_conversation_mode || !s_mic_capturing || s_mic_waiting) return;
  uint64_t energy=0;
  for(size_t i=0;i<count;i++){int32_t v=samples[i];energy+=(uint64_t)(v*v);}
  bool active=count>0 && (energy/count)>360000; // RMS >600/32768
  uint8_t frame[HA_FRAME_BYTES];
  ha_mic_encode(samples,count,frame);
  if(!s_mic_utterance) {
    memcpy(s_preroll[s_preroll_at],frame,HA_FRAME_BYTES);
    s_preroll_at=(s_preroll_at+1)%HA_PREROLL_FRAMES;
    if(s_preroll_len<HA_PREROLL_FRAMES)s_preroll_len++;
    if(active)s_mic_speech_frames++; else s_mic_speech_frames=0;
    if(s_mic_speech_frames>=3) {
      s_mic_utterance=true;s_mic_start_pending=true;s_mic_seq=0;
      s_mic_silence=0;s_mic_frames=0;
      for(uint8_t i=0;i<s_preroll_len;i++){
        uint8_t pos=(s_preroll_at+HA_PREROLL_FRAMES-s_preroll_len+i)%HA_PREROLL_FRAMES;
        ha_mic_enqueue(s_preroll[pos]);
      }
      s_preroll_len=0;
      ha_mic_flush();
    }
    return;
  }
  ha_mic_enqueue(frame);
  s_mic_frames++;
  if(active)s_mic_silence=0;else s_mic_silence++;
  if(s_mic_overflow || s_mic_silence>=HA_SILENCE_FRAMES || s_mic_frames>=HA_MAX_FRAMES)
    ha_mic_finish();
  else ha_mic_flush();
}
static void ha_mic_stopped(MicCaptureStopReason reason,void *context) {
  s_mic_capturing=false;
  if(s_conversation_mode && !s_mic_waiting) {
    s_mic_waiting=true;
    s_mic_cancel_pending=true;
    ha_mic_flush();
    set_status("Microphone stopped");
  }
}
static void ha_mic_flush(void) {
  if(s_mic_tx_busy || (!s_conversation_mode && !s_mic_cancel_pending)) return;
  const char *cmd=NULL;
  if(s_mic_cancel_pending)cmd="MIC_CANCEL";
  else if(s_mic_start_pending)cmd="MIC_START";
  else if(s_mic_count>=2 || (s_mic_count>0 && s_mic_end_pending))
    cmd="MIC_AUDIO";
  else if(s_mic_end_pending)cmd=s_mic_overflow?"MIC_CANCEL":"MIC_END";
  if(!cmd)return;
  DictionaryIterator *iter=NULL;
  if(app_message_outbox_begin(&iter)!=APP_MSG_OK || !iter)return;
  dict_write_cstring(iter,MESSAGE_KEY_COMMAND,cmd);
  uint8_t frame_count=0;
  if(strcmp(cmd,"MIC_AUDIO")==0) {
    uint8_t packet[HA_FRAME_BYTES*2];
    frame_count=s_mic_count>=2?2:1;
    for(uint8_t i=0;i<frame_count;i++) {
      uint16_t pos=(s_mic_head+i)%HA_QUEUE_FRAMES;
      memcpy(packet+i*HA_FRAME_BYTES,s_mic_queue[pos],HA_FRAME_BYTES);
    }
    dict_write_data(iter,MESSAGE_KEY_CHUNK,packet,HA_FRAME_BYTES*frame_count);
    dict_write_int32(iter,MESSAGE_KEY_VOLUME,(int32_t)s_mic_seq);
  }
  AppMessageResult result=app_message_outbox_send();
  if(result!=APP_MSG_OK)return;
  s_mic_tx_busy=true;
  if(s_mic_cancel_pending){s_mic_cancel_pending=false;s_mic_count=0;}
  else if(s_mic_start_pending)s_mic_start_pending=false;
  else if(frame_count) {
    s_mic_head=(s_mic_head+frame_count)%HA_QUEUE_FRAMES;
    s_mic_count-=frame_count;s_mic_seq+=frame_count;
  } else if(s_mic_end_pending)s_mic_end_pending=false;
}
static void ha_mic_tx_sent(DictionaryIterator *iter,void *context) {
  s_mic_tx_busy=false;ha_mic_flush();
}
static void ha_mic_tx_failed(DictionaryIterator *iter,AppMessageResult reason,void *context) {
  s_mic_tx_busy=false;
  s_mic_overflow=true;s_mic_end_pending=false;s_mic_count=0;
  s_mic_cancel_pending=true;
  ha_mic_halt();
  ha_mic_flush();
  set_status("Mic link lost");
}
static void ha_mic_restart(void) {
  if(!s_conversation_mode || s_mic_capturing)return;
  s_mic_waiting=false;s_mic_utterance=false;s_mic_overflow=false;
  s_mic_end_pending=false;s_mic_start_pending=false;s_mic_cancel_pending=false;
  s_mic_head=s_mic_tail=s_mic_count=0;s_preroll_len=s_preroll_at=0;
  s_mic_silence=s_mic_frames=s_mic_speech_frames=0;
  MicCaptureStartResult result=mic_capture_start((MicCaptureHandlers){
    .data=ha_mic_data,.stopped=ha_mic_stopped
  },NULL);
  s_mic_capturing=(result==0); // MicCaptureStartOK value 0.
  if(s_mic_capturing) set_status("Listening...");
  else {s_mic_waiting=true;set_status("Mic unavailable");}
}
#endif

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
    if(s_conversation_mode) {
      ha_mic_halt();s_mic_count=0;s_mic_end_pending=false;
      s_mic_start_pending=false;s_mic_cancel_pending=true;
      ha_mic_flush();s_conversation_mode=false;s_mic_waiting=true;
    }
  #endif
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

// The Back button returns from results to the idle screen; at idle the
// default Pebble Back action remains active and exits the application.
static void results_back_click_handler(ClickRecognizerRef recognizer, void *context) {
  #ifdef PBL_SPEAKER
    s_ignore_audio = true;
    stop_audio();
  #endif
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
 
    
    #ifdef PBL_SPEAKER
      window_long_click_subscribe(BUTTON_ID_UP, 500, up_volume_handler, NULL);
      window_long_click_subscribe(BUTTON_ID_DOWN, 500, down_volume_handler, NULL);
    #endif
  } else {
    window_single_click_subscribe(BUTTON_ID_SELECT, select_short_click_handler); 
 
    
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
      #if HA_MIC_AVAILABLE
      text_layer_set_text(s_prompt_layer,
        s_conversation_mode ?
          (s_mic_capturing ? "Conversation mode\nListening..." :
                             "Conversation mode\nMicrophone unavailable") :
          "Press Select\nto record");
      #else
      text_layer_set_text(s_prompt_layer, "Press Select\nto record");
      #endif 
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
      if(s_conversation_mode)ha_mic_halt();
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
    if (!s_speaker_open && s_buffer_count > 0) start_playback(); 
  } 
  #endif
  
  else if(strcmp(command_tuple->value->cstring,"CONV_RESUME")==0) {
    #if HA_MIC_AVAILABLE
    if(s_conversation_mode)ha_mic_restart();
    #endif
  }
  else if(strcmp(command_tuple->value->cstring,"CONV_AUDIO_END")==0) {
    // The BLE sender completed; do not listen until speaker buffer drains.
    #if HA_MIC_AVAILABLE
    if(s_conversation_mode) {
      #ifdef PBL_SPEAKER
      s_conversation_audio_complete=true;
      #else
      ha_mic_restart();
      #endif
    }
    #endif
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
      set_ui_state(UI_STATE_IDLE);
      set_status("Phone message queue busy");
      ha_haptic();
      return;
    }
    dict_write_cstring(iter, MESSAGE_KEY_COMMAND, "DICTATION"); 
    dict_write_cstring(iter, MESSAGE_KEY_TEXT, transcription);  
    
    #ifdef PBL_SPEAKER
      dict_write_int32(iter, MESSAGE_KEY_VOLUME, (int)(s_volume * 100.0f + 0.5f)); 
    #else
      dict_write_int32(iter, MESSAGE_KEY_VOLUME, 0); 
    #endif
    
    if (app_message_outbox_send() != APP_MSG_OK) {
      set_ui_state(UI_STATE_IDLE);
      set_status("Could not send to phone");
      ha_haptic();
    }
  } else {
    set_ui_state(UI_STATE_IDLE);
    if (status != DictationSessionStatusFailureTranscriptionRejected) {
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
#if HA_MIC_AVAILABLE
  s_conversation_mode=false;ha_mic_halt();
#endif
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
  app_message_register_outbox_sent(ha_mic_tx_sent);
  app_message_register_outbox_failed(ha_mic_tx_failed);
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