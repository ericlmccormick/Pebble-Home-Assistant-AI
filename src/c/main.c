// =========================================================================
// SECTION 1: SYSTEM HEADERS & PREPROCESSOR MACROS
// =========================================================================

#include <pebble.h>
#include "ha_audio.h"
// The plugin API does not expose a raw, continuous microphone stream.
// All voice input uses PebbleOS system dictation and Bridge conversation.
#define MAX_TEXT_LENGTH 2048
#ifdef PBL_SPEAKER
  #define RING_BUFFER_SIZE 16384           
  #define PERSIST_KEY_VOLUME 100           
  #define PLAYBACK_ADPCM_BYTES 800         
  #define PLAYBACK_PCM_SAMPLES (PLAYBACK_ADPCM_BYTES * 2) 
  #define PLAYBACK_INTERVAL_MS 200         
  #define START_BUFFER_THRESHOLD 2800      
  #define STREAM_CLOSE_DELAY_MS 1500       
#endif

// =========================================================================
// SECTION 2: GLOBAL UI STATE MACHINE VARIABLES & POINTERS
// =========================================================================

typedef enum { UI_STATE_IDLE, UI_STATE_THINKING, UI_STATE_RESULTS } UIState;

static UIState s_current_state = UI_STATE_IDLE;
// Conversation mode repeats PebbleOS dictation turns through the Bridge.
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
// SECTION 3: Volume UI
#ifdef PBL_SPEAKER
static TextLayer *s_volume_text_layer;
static AppTimer *s_volume_timer=NULL;
static float s_volume=1.0f;
#endif
// SECTION 4: FUNCTION PROTOTYPES & FORWARD DECLARATIONS
// =========================================================================

static void set_ui_state(UIState state);       
static void window_click_config_provider(void *context);
static void conversation_disable(void);
static void conversation_schedule_resume(void);
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
// SECTION 6: Volume controls — codec and playback are in ha_audio.c
#ifdef PBL_SPEAKER
static void hide_volume_layer_callback(void *data){
  s_volume_timer=NULL;
  if(s_volume_text_layer)layer_set_hidden(text_layer_get_layer(s_volume_text_layer),true);
}
static void show_volume_indicator(void){
  static char buf[16];
  snprintf(buf,sizeof(buf),"Vol: %d%%",(int)(100*s_volume+0.5f));
  text_layer_set_text(s_volume_text_layer,buf);
  layer_set_hidden(text_layer_get_layer(s_volume_text_layer),false);
  if(s_volume_timer)app_timer_cancel(s_volume_timer);
  s_volume_timer=app_timer_register(2000,hide_volume_layer_callback,NULL);
}
static void up_volume_handler(ClickRecognizerRef recognizer,void *context){
  s_volume+=0.1f;if(s_volume>1)s_volume=1;
  ha_audio_set_volume(s_volume);
  persist_write_int(PERSIST_KEY_VOLUME,(int)(100*s_volume+0.5f));
  ha_haptic();show_volume_indicator();
}
static void down_volume_handler(ClickRecognizerRef recognizer,void *context){
  s_volume-=0.1f;if(s_volume<0)s_volume=0;
  ha_audio_set_volume(s_volume);
  persist_write_int(PERSIST_KEY_VOLUME,(int)(100*s_volume+0.5f));
  ha_haptic();show_volume_indicator();
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
  if(s_conversation_audio_complete){
    if(ha_audio_is_playing()){conversation_schedule_resume();return;}
    s_conversation_audio_complete=false;
  }
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
  s_dictation_fallback = false;
  // Do not leave a stale "listening" claim visible after a cancelled turn.
  set_status(NULL);
}
static void conversation_toggle(void){
  if(s_conversation_mode){
    conversation_disable();set_ui_state(UI_STATE_IDLE);ha_haptic();return;
  }
  ha_audio_stop();s_conversation_mode=true;s_dictation_fallback=true;
  s_conversation_dictating=false;conversation_schedule_resume();ha_haptic();
}
// =========================================================================
// SECTION 7: HARDWARE KEY BOARD REGISTRATION & INTERCEPT MAPPINGS
// =========================================================================

static void select_short_click_handler(ClickRecognizerRef recognizer, void *context) {
  if(ha_audio_is_playing())ha_audio_stop();
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
    return;
  }
  window_stack_pop(true);
}

static void results_back_click_handler(ClickRecognizerRef recognizer, void *context) {
  ha_audio_stop();
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
  if(ha_audio_handle_message(iterator)){
    Tuple *cmd=dict_find(iterator,MESSAGE_KEY_COMMAND);
    if(cmd && cmd->value && cmd->value->cstring &&
      !strcmp(cmd->value->cstring,"AUDIO_CHUNK"))set_status(NULL);
    return;
  }
  Tuple *command_tuple = dict_find(iterator, MESSAGE_KEY_COMMAND); 
  if (!command_tuple) return;                   

  if (strncmp(command_tuple->value->cstring, "TEXT_RESPONSE", 13) == 0) {
    if(no_audio)ha_audio_stop();
    Tuple *text_tuple = dict_find(iterator, MESSAGE_KEY_TEXT); 
    if (text_tuple) {
      snprintf(s_ha_text, sizeof(s_ha_text), "%s", text_tuple->value->cstring); 
      text_layer_set_text(s_text_layer, s_ha_text);
      update_text_layout();
      ha_haptic();                     
      
      set_ui_state(UI_STATE_RESULTS);          

      if(no_audio)set_status(NULL);
        else set_status("Buffering Audio...");
        
    }
  } 
  
  else if(strcmp(command_tuple->value->cstring,"CONV_RESUME")==0) {
    if(s_conversation_mode) conversation_schedule_resume();
  }
  else if(strcmp(command_tuple->value->cstring,"CONV_AUDIO_END")==0) {
    // The BLE sender completed; do not listen until speaker buffer drains.
    if(s_conversation_mode) {
        s_conversation_audio_complete=true;
        conversation_schedule_resume();
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
    ha_audio_stop();                               
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
  ha_audio_init();
  #ifdef PBL_SPEAKER
    if (persist_exists(PERSIST_KEY_VOLUME)) s_volume = persist_read_int(PERSIST_KEY_VOLUME) / 100.0f;
    else s_volume = 1.0f;
    ha_audio_set_volume(s_volume);
  #endif
  
  app_message_register_inbox_received(inbox_received_callback);
  
  s_main_window = window_create();              
  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load = main_window_load, .unload = main_window_unload 
  });
  
  window_set_click_config_provider(s_main_window, window_click_config_provider);
  window_stack_push(s_main_window, true);       
}

static void deinit() { 
  window_destroy(s_main_window);
  ha_audio_deinit();                
}

int main(void) { 
  init();                                       
  app_event_loop();                             
  deinit();                                     
}