// =========================================================================
// SECTION 1: SYSTEM HEADERS & PREPROCESSOR MACROS
// =========================================================================

#include <pebble.h> 

#define MAX_TEXT_LENGTH 2048 

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
static Window *s_main_window;                   
static ScrollLayer *s_scroll_layer;             
static TextLayer *s_text_layer;                 
static TextLayer *s_status_layer;               
static Layer *s_idle_layer;                     
                  
               
static TextLayer *s_title_layer;                
static TextLayer *s_prompt_layer;               
static Layer *s_arrow_layer;                    
static Layer *s_pinwheel_layer;                 
static AppTimer *s_pinwheel_timer = NULL;       
static int s_pinwheel_angle = 0;                
static DictationSession *s_dictation_session;   
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
    vibes_short_pulse();                        
    show_volume_indicator();                    
  }

  static void down_volume_handler(ClickRecognizerRef recognizer, void *context) {
    s_volume -= 0.1f;                           
    if (s_volume < 0.0f) s_volume = 0.0f;       
    persist_write_int(PERSIST_KEY_VOLUME, (int)(s_volume * 100.0f + 0.5f)); 
    vibes_short_pulse();                        
    show_volume_indicator();                    
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
  dictation_session_start(s_dictation_session); 
}

static void select_long_click_handler(ClickRecognizerRef recognizer, void *context) {
  #ifdef PBL_SPEAKER
  if (s_speaker_open || s_buffer_count > 0) {
    s_ignore_audio = true;                      
    stop_audio();                               
    vibes_double_pulse();                       
    set_ui_state(UI_STATE_IDLE);                
  }
  #endif
  
  #ifndef PBL_SPEAKER
  vibes_double_pulse();                         
  set_ui_state(UI_STATE_IDLE);
  #endif
}

static void window_click_config_provider(void *context) {
  if (s_current_state == UI_STATE_RESULTS) {    
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
      layer_set_hidden(scroll_layer_get_layer(s_scroll_layer), true); 
      layer_set_hidden(s_arrow_layer, false);   
      layer_set_hidden(s_pinwheel_layer, true);  
      text_layer_set_text(s_prompt_layer, "Press Select\nto record"); 
      break;
    case UI_STATE_THINKING:                     
      layer_set_hidden(s_idle_layer, false);    
      layer_set_hidden(scroll_layer_get_layer(s_scroll_layer), true); 
      layer_set_hidden(s_arrow_layer, true);    
      layer_set_hidden(s_pinwheel_layer, false); 
      text_layer_set_text(s_prompt_layer, "Thinking..."); 
      if (!s_pinwheel_timer) {                   
        s_pinwheel_timer = app_timer_register(100, pinwheel_timer_callback, NULL); 
      }
      break;
    case UI_STATE_RESULTS:                      
      layer_set_hidden(s_idle_layer, true);     
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
    bool no_audio = false;

    #ifdef PBL_SPEAKER
      // MULTIPLEXING INTERCEPT: Determine if the phone told us to expect audio chunks
      if (strcmp(command_tuple->value->cstring, "TEXT_RESPONSE_NO_AUDIO") == 0) {
        no_audio = true;
        s_ignore_audio = true;
      }
    #endif

    Tuple *text_tuple = dict_find(iterator, MESSAGE_KEY_TEXT); 
    if (text_tuple) {
      snprintf(s_gemini_text, sizeof(s_gemini_text), "%s", text_tuple->value->cstring); 
      text_layer_set_text(s_text_layer, s_gemini_text); 
      update_text_layout();                     
      
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
  if (status == DictationSessionStatusSuccess) { 
    set_ui_state(UI_STATE_THINKING);            
    text_layer_set_text(s_text_layer, "");      
    update_text_layout();                       

    DictionaryIterator *iter;                   
    app_message_outbox_begin(&iter);            
    dict_write_cstring(iter, MESSAGE_KEY_COMMAND, "DICTATION"); 
    dict_write_cstring(iter, MESSAGE_KEY_TEXT, transcription);  
    
    #ifdef PBL_SPEAKER
      dict_write_int32(iter, MESSAGE_KEY_VOLUME, (int)(s_volume * 100.0f + 0.5f)); 
    #else
      dict_write_int32(iter, MESSAGE_KEY_VOLUME, 0); 
    #endif
    
    app_message_outbox_send();                  
  } else {
    set_ui_state(UI_STATE_IDLE);                
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
    s_title_layer = text_layer_create(GRect(0, 65, bounds.size.w, 35));
    text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter); 

    s_prompt_layer = text_layer_create(GRect(10, 105, bounds.size.w - 20, 50));
    text_layer_set_text_alignment(s_prompt_layer, GTextAlignmentCenter); 

    s_arrow_layer = layer_create(GRect(bounds.size.w - 30, 110, 20, 20));
    s_pinwheel_layer = layer_create(GRect(bounds.size.w - 35, 105, 30, 30));
  #else 
    s_title_layer = text_layer_create(GRect(10, 20, bounds.size.w - 20, 40));
    text_layer_set_text_alignment(s_title_layer, GTextAlignmentLeft); 

    s_prompt_layer = text_layer_create(GRect(0, 80, bounds.size.w - 30, 50));
    text_layer_set_text_alignment(s_prompt_layer, GTextAlignmentRight); 

    s_arrow_layer = layer_create(GRect(bounds.size.w - 25, 95, 25, 20));
    s_pinwheel_layer = layer_create(GRect(bounds.size.w - 30, 90, 30, 30));
  #endif

 

  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_text(s_title_layer, "Home AI");
  layer_add_child(s_idle_layer, text_layer_get_layer(s_title_layer));

  text_layer_set_font(s_prompt_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24));
  text_layer_set_text(s_prompt_layer, "Press Select\nto record");
  layer_add_child(s_idle_layer, text_layer_get_layer(s_prompt_layer));

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

  s_dictation_session = dictation_session_create(sizeof(s_gemini_text), dictation_session_callback, NULL);

  set_ui_state(UI_STATE_IDLE); 
}

static void main_window_unload(Window *window) {
  #ifdef PBL_SPEAKER
    stop_audio();                               
    if (s_volume_timer) app_timer_cancel(s_volume_timer); 
    text_layer_destroy(s_volume_text_layer);    
  #endif
  
  dictation_session_destroy(s_dictation_session); 
 
           
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