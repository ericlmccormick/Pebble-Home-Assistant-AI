const assert=require('assert'),fs=require('fs'),path=require('path');
const sdk=fs.readFileSync(path.join(__dirname,'../src/pkjs/ha_audio.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'../src/pkjs/index.js'),'utf8');
assert(sdk.includes("pluginAction('tts_prepare',{text:sentence})"),
  'Bridge must synthesize next sentence ahead of playback');
assert(sdk.includes('prefetchNextBridgeSentence(gen);'),
  'The next sentence must prepare before the active sentence ends');
assert(sdk.includes('streamedAdpcm>=3000 || last'),
  'The current sentence gets priority through its first 750ms');
assert(sdk.includes('},selected.prepared)'),
  'The consumer must reuse a prefetched Bridge result');
assert(sdk.includes('MAX_READY_AUDIO_SENTENCES=2'),
  'Sentence queue must be bounded');
assert(sdk.includes('nextRequest-nextEmit<step*3'),
  'Chunk fetching must use a bounded rolling window');
assert(sdk.includes('if(!endSentence)'),
  'WAV chunk boundaries must not act as sentence boundaries');
assert(!sdk.includes('setTimeout(function(){startBLESendLoop();conversationMaybeCompleteAudio();}, 120)'),
  'No arbitrary 120ms pause between sentences');
assert(app.includes("audio.speak(lastAnswer)"),
  'Home Assistant AI must use SDK speech rather than direct internal TTS');
console.log('Vendored SDK sentence prefetch, chunk ordering and BLE continuity checks passed');
