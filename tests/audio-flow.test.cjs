const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../src/pkjs/index.js'),'utf8');
assert(source.includes("Promise.all(pending)"),'Bridge WAV chunks must be fetched in bounded parallel batches');
assert(source.includes('meta.first_chunk'),'Consume first WAV chunk inline');
assert(source.includes('pluginStreamWav(sentence,gen,function(audio,last)'),
  'Plugin TTS must stream verified chunks instead of full WAV');
assert(source.includes('readyAudioQueue.push({bytes:audio,endSentence:last})'),
  'Producer must mark only the final audio segment as sentence end');
assert(source.includes('if(!endSentence){'),
  'BLE sender must not insert a sentence-end marker at each WAV chunk');
assert(!source.includes('setTimeout(function(){startBLESendLoop();conversationMaybeCompleteAudio();}, 120)'),
  'No artificial 120ms pause at sentence handoff');
assert(source.includes('streamedAdpcm>=3000 || last'),
  'First three streamed chunks must get priority over next-sentence synthesis');
assert(source.includes('MAX_PENDING_STREAM_SEGMENTS=8'),
  'Progressive producer must use bounded in-memory backpressure');
assert(source.includes('return receiveBatch(initialOffset)'),
  'Never re-request already inlined chunk');
const start=source.indexOf('var bleFlowGeneration=');
const end=source.indexOf('function startBLESendLoop()',start);
assert(start>=0&&end>start,'Bluetooth pacing helper missing');
const pacing=vm.runInNewContext(source.slice(start,end)+
  '\n({wait:bleAudioWaitMs,ack:bleAudioAck,queue:bleAudioQueueEstimate})');
let t=0,transmitted=0,peak=0,firstPlayback=null;
while(transmitted<80000){
  const size=Math.min(700,80000-transmitted);
  const delay=pacing.wait(size,t);
  if(delay>0){t+=delay;continue;}
  t+=25; // simulated AppMessage callback overhead
  pacing.ack(size,t);
  transmitted+=size;
  if(firstPlayback===null&&transmitted>=3000)firstPlayback=t;
  peak=Math.max(peak,pacing.queue(t));
  t+=10;
}
assert(peak<=9000,'Send-ahead estimation must not overfill its safety limit');
assert(firstPlayback<400,'Initial packets should not incur a 175ms fixed delay');
assert(source.includes('BLE_PREBUFFER_BYTES=2800'),
  'Phone flow estimator must match the watch startup threshold');
assert(transmitted===80000,'Full long response must be delivered');
// The Gemini pipeline overlaps sentence generation with transport. This
// tests both the producer's bounded queue and the watch's ping-pong frames.
assert(source.includes('MAX_READY_AUDIO_SENTENCES=2'),'Keep only two next-sentence buffers');
assert(source.includes('readyAudioQueue.length>=MAX_READY_AUDIO_SENTENCES'),
  'Do not fetch indefinitely ahead on long speech');
assert(source.includes('if(useHaPlugin)startPluginTTSFetchLoop(requestGeneration);'),
  'Consumer must wake the plugin producer as space frees');
const watch=fs.readFileSync(path.join(__dirname,'../src/c/main.c'),'utf8');
assert(watch.includes('stop_audio();\n        s_ignore_audio = true;'),
  'Corrupted progressive audio must stop watch playback on failure');
assert(watch.includes('#define START_BUFFER_THRESHOLD 2800'),
  'Start playback after three 700-byte BLE packets');
assert(watch.includes('app_timer_register(1, playback_timer_callback, NULL)'),
  'Do not wait an extra full frame before first playback');
assert(watch.includes('s_pcm_frames[2][PLAYBACK_PCM_SAMPLES]'),
  'Watch must have two independent PCM frames');
assert(watch.includes('s_pcm_queued < 2'),
  'Watch may prepare next PCM frame while previous one drains');
assert(watch.includes('s_pending_offset<s_pcm_lengths[slot]'),
  'A partial speaker write must never discard unwritten bytes');
assert(watch.includes('s_sentence_end_pending && s_buffer_count > 0'),
  'Short trailing sentence audio must be preserved');
assert(watch.includes('length > RING_BUFFER_SIZE - s_buffer_count'),
  'Ring overflow must never silently discard ADPCM predictor bytes');
assert(source.includes("if(d.COMMAND==='AUDIO_STATS')"),
  'Phone must consume watch-side playback telemetry');
assert(source.includes('PCM buffer-empty events:'),
  'Settings must expose watch-side empty PCM events');
assert(watch.includes('report_audio_stats();'),
  'Watch must report completed speaker sessions');
assert(watch.includes('s_audio_partial_writes++'),
  'Watch must count short writes');
assert(watch.includes('s_audio_empty_events++'),
  'Watch must count PCM-empty episodes');
console.log('Gemini-style double-buffer and producer/consumer invariants passed');
console.log('Audio flow and bounded send-ahead regression checks passed');
