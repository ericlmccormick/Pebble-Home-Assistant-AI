/* Pebble Home Assistant Bridge watch audio transport SDK v1.
 * MIT licensed. Audio codec/PCM scheduler extracted from the validated
 * Home Assistant AI transport, not its UI, microphone, or conversation logic.
 * Message keys: COMMAND, TEXT, CHUNK. App registers one inbox handler and
 * delegates AUDIO_* commands here.
 */
#include "ha_audio.h"
#include <string.h>
#include <stdio.h>
#ifdef PBL_SPEAKER
#define RING_BUFFER_SIZE 16384
#define PLAYBACK_ADPCM_BYTES 800
#define PLAYBACK_PCM_SAMPLES (PLAYBACK_ADPCM_BYTES * 2)
#define PLAYBACK_INTERVAL_MS 200
#define START_BUFFER_THRESHOLD 2800
#define STREAM_CLOSE_DELAY_MS 1500
static float s_volume=1.0f;
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
  // Playback counters are transmitted only once the speaker closes.
  static bool s_audio_frame_written = false;
  static bool s_audio_waiting = false;
  static uint16_t s_audio_empty_events = 0;
  static uint32_t s_audio_empty_ms = 0;
  static uint16_t s_audio_partial_writes = 0;
  static uint16_t s_audio_zero_writes = 0;
  static uint16_t s_audio_frames_written = 0;
  static uint32_t s_audio_max_queued = 0;           
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

  static void report_audio_stats(void) {
    DictionaryIterator *iter=NULL;
    if(app_message_outbox_begin(&iter)!=APP_MSG_OK||!iter)return;
    char stats[144];
    snprintf(stats,sizeof(stats),
      "empty=%u,empty_ms=%lu,partial=%u,zero=%u,peak=%lu,frames=%u",
      (unsigned)s_audio_empty_events,(unsigned long)s_audio_empty_ms,
      (unsigned)s_audio_partial_writes,(unsigned)s_audio_zero_writes,
      (unsigned long)s_audio_max_queued,(unsigned)s_audio_frames_written);
    dict_write_cstring(iter,MESSAGE_KEY_COMMAND,"AUDIO_STATS");
    dict_write_cstring(iter,MESSAGE_KEY_TEXT,stats);
    app_message_outbox_send();
  }
  static void delayed_close_callback(void *data) {
    s_stream_close_timer = NULL;                
    if (s_buffer_count == 0 && s_pcm_queued == 0 && s_speaker_open) { 
      speaker_stream_close();                   
      s_speaker_open = false;
      if(s_audio_frame_written)report_audio_stats();
      s_audio_frame_written=false;
      s_audio_waiting=false;

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

      return;
    }
    for (uint16_t i = 0; i < length; i++) {
      s_ring_buffer[s_tail] = data[i];
      s_tail = (s_tail + 1) % RING_BUFFER_SIZE;
      s_buffer_count++;
    }
    if(s_buffer_count>s_audio_max_queued)s_audio_max_queued=s_buffer_count;
    cancel_close_timer();
  }

  static void start_playback() {
    cancel_close_timer();                       

    if (!s_speaker_open) {                      
      bool success = speaker_stream_open(SpeakerPcmFormat_8kHz_16bit, 100);
      if (!success) {
        APP_LOG(APP_LOG_LEVEL_ERROR, "Speaker failed to open"); 
        return;
      }
      s_speaker_open = true;                    
    }

    if (!s_playback_timer) {                     
      s_playback_timer = app_timer_register(1, playback_timer_callback, NULL); 
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
      if(s_audio_frame_written){
        if(!s_audio_waiting){
          s_audio_waiting=true;
          if(s_audio_empty_events<65535)s_audio_empty_events++;
        }
        s_audio_empty_ms+=20;
      }
      schedule_close_timer();
      s_playback_timer=app_timer_register(20,playback_timer_callback,NULL);
      return;
    }
    s_audio_waiting=false;
    cancel_close_timer();
    uint8_t slot=s_pcm_read;
    uint32_t remaining=s_pcm_lengths[slot]-s_pending_offset;
    uint32_t accepted=speaker_stream_write(
      ((uint8_t*)s_pcm_frames[slot])+s_pending_offset,remaining);
    if(accepted>remaining)accepted=remaining;
    if(accepted<remaining && s_audio_partial_writes<65535)s_audio_partial_writes++;
    if(!accepted && s_audio_zero_writes<65535)s_audio_zero_writes++;
    if(accepted){
      s_audio_frame_written=true;
      if(s_audio_frames_written<65535)s_audio_frames_written++;
    }
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

  }


static void clear_stats(void){
  s_audio_frame_written=false;s_audio_waiting=false;
  s_audio_empty_events=0;s_audio_empty_ms=0;
  s_audio_partial_writes=0;s_audio_zero_writes=0;
  s_audio_frames_written=0;s_audio_max_queued=0;
}
void ha_audio_init(void){clear_stats();s_ignore_audio=false;reset_adpcm_state();}
void ha_audio_stop(void){stop_audio();s_ignore_audio=true;}
void ha_audio_deinit(void){ha_audio_stop();}
void ha_audio_set_volume(float v){
  if(v<0)v=0;if(v>1)v=1;s_volume=v;
}
bool ha_audio_is_playing(void){return s_speaker_open||s_buffer_count||s_pcm_queued;}
bool ha_audio_handle_message(DictionaryIterator *iter){
  if(!iter)return false;
  Tuple *cmd=dict_find(iter,MESSAGE_KEY_COMMAND);
  if(!cmd||cmd->type!=TUPLE_CSTRING)return false;
  const char *c=cmd->value->cstring;
  if(!strcmp(c,"AUDIO_RESET")){
    stop_audio();clear_stats();s_ignore_audio=false;return true;
  }
  if(!strcmp(c,"AUDIO_STOP")){ha_audio_stop();return true;}
  if(!strcmp(c,"AUDIO_CHUNK")){
    if(s_ignore_audio)return true;
    Tuple *payload=dict_find(iter,MESSAGE_KEY_CHUNK);
    if(payload && payload->length){
      push_to_ring_buffer(payload->value->data,payload->length);
      if(!s_speaker_open && s_buffer_count>=START_BUFFER_THRESHOLD)
        start_playback();
    }
    return true;
  }
  if(!strcmp(c,"AUDIO_SENTENCE_END")){
    if(s_ignore_audio)return true;
    s_sentence_end_pending=s_buffer_count>0;
    if(!s_speaker_open && s_buffer_count>0)start_playback();
    return true;
  }
  return false;
}
#else
void ha_audio_init(void){}
void ha_audio_deinit(void){}
void ha_audio_stop(void){}
void ha_audio_set_volume(float v){(void)v;}
bool ha_audio_is_playing(void){return false;}
bool ha_audio_handle_message(DictionaryIterator *iter){(void)iter;return false;}
#endif
