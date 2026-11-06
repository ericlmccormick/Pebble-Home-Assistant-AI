/* Pebble Home Assistant Bridge audio transport SDK, v1.
 * Copy to src/pkjs/ha_audio.js and require('./ha_audio').
 * Requires the HA Bridge plugin, PBL_SPEAKER, and message keys COMMAND/TEXT/CHUNK.
 * No HA token, URL, or direct server requests in this module.
 * Copyright (c) 2026 contributors. MIT licensed.
 */
'use strict';
var DEFAULT_PLUGIN_ID='a74370b6-929c-4ec0-b7ee-2fc6fca8db57';
module.exports={
  create:function(options){
    options=options||{};
    var Pebble=options.Pebble;
    var localStorage=options.storage;
    if(!Pebble||!localStorage||typeof Pebble.invokeAction!=='function')
      throw Error('Pebble plugin invokeAction is required');
    var HA_PLUGIN_UUID=options.pluginId||DEFAULT_PLUGIN_ID;
    var PCM_DEBUG_STORAGE_KEY=options.diagnosticsKey||'HA_AUDIO_LIBRARY_DIAG_V1';
    var onError=options.onError||null,onComplete=options.onComplete||null;
    var onStats=options.onStats||null;
    var lastAnswer='';
    var sentenceQueue=[],readyAudioQueue=[];
    var MAX_READY_AUDIO_SENTENCES=2;
    var isFetchingTTS=false,isSendingBLE=false,requestGeneration=0;
    var js_adpcm_valpred=0,js_adpcm_index=0;
    var conversationAudioFinalPending=false;
    function conversationMaybeCompleteAudio(){
      if(!conversationAudioFinalPending||isFetchingTTS||isSendingBLE||
         sentenceQueue.length||readyAudioQueue.length||pluginPreparedSentence)return;
      conversationAudioFinalPending=false;
      if(onComplete)onComplete();
    }

var stepTable = [
  7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,
  34,37,41,45,50,55,60,66,73,80,88,97,107,118,
  130,143,157,173,190,209,230,253,279,307,337,
  371,408,449,494,544,598,658,724,796,876,963,
  1060,1166,1282,1411,1552,1707,1878,2066,2272,
  2499,2749,3024,3327,3660,4026,4428,4871,5358,
  5894,6484,7132,7845,8630,9493,10442,11487,
  12635,13899,15289,16818,18500,20350,22385,
  24623,27086,29794,32767
];
var indexTable = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];

var pluginPreparedSentence=null;
function prefetchNextBridgeSentence(gen){
  if(gen!==requestGeneration||pluginPreparedSentence||
     !sentenceQueue.length)return;
  var sentence=sentenceQueue.shift();
  var entry={sentence:sentence,gen:gen,promise:null};
  // Resolve failures as values to avoid unhandled rejections while the active
  // sentence is still streaming. Surface them when this sentence is consumed.
  entry.promise=pluginAction('tts_prepare',{text:sentence}).then(
    function(result){return {result:result};},
    function(error){return {error:error};}
  );
  pluginPreparedSentence=entry;
}
function consumePreparedBridgeSentence(gen){
  if(pluginPreparedSentence&&pluginPreparedSentence.gen!==gen)
    pluginPreparedSentence=null;
  if(pluginPreparedSentence){
    var selected=pluginPreparedSentence;
    pluginPreparedSentence=null;
    return {sentence:selected.sentence,prepared:selected.promise.then(function(value){
      if(value.error)throw value.error;
      return value.result;
    })};
  }
  if(!sentenceQueue.length)return null;
  return {sentence:sentenceQueue.shift(),prepared:null};
}


function encodeADPCM(pcm16) {
  var adpcm = [];     
  var buffer = 0;     
  var toggle = false; 

  for (var i = 0; i < pcm16.length; i++) {
    var diff = pcm16[i] - js_adpcm_valpred; 
    var sign = (diff < 0) ? 8 : 0;          
    if (sign) diff = -diff;                 

    var step = stepTable[js_adpcm_index];   
    var delta = 0;                          
    var vpdiff = (step >> 3);               

    if (diff >= step) { delta |= 4; diff -= step; vpdiff += step; }
    step >>= 1;
    if (diff >= step) { delta |= 2; diff -= step; vpdiff += step; }
    step >>= 1;
    if (diff >= step) { delta |= 1; vpdiff += step; }

    if (sign) { js_adpcm_valpred -= vpdiff; } 
    else { js_adpcm_valpred += vpdiff; }

    if (js_adpcm_valpred > 32767) js_adpcm_valpred = 32767;     
    if (js_adpcm_valpred < -32768) js_adpcm_valpred = -32768;   

    delta |= sign;                             
    js_adpcm_index += indexTable[delta];       

    if (js_adpcm_index < 0) js_adpcm_index = 0;   
    if (js_adpcm_index > 88) js_adpcm_index = 88; 

    if (toggle) {
      buffer |= (delta & 0x0F);   
      adpcm.push(buffer);         
      toggle = false;             
    } else {
      buffer = (delta & 0x0F) << 4; 
      toggle = true;              
    }
  }

  if (toggle) { adpcm.push(buffer); } 
  return adpcm;
}


var pluginB64Alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function pluginDecodeBase64(input){
  var output=[],buffer=0,bits=0;
  for(var i=0;i<input.length;i++){
    var ch=input.charAt(i);
    if(ch==='=')break;
    var v=pluginB64Alphabet.indexOf(ch);
    if(v<0)throw Error('Invalid plugin audio encoding');
    buffer=(buffer<<6)|v;bits+=6;
    if(bits>=8){bits-=8;output.push((buffer>>bits)&255);}
  }
  return output;
}
function pluginWavChecksum(bytes){
  var hash=2166136261>>>0;
  for(var i=0;i<bytes.length;i++)
    hash=Math.imul((hash^bytes[i])>>>0,16777619)>>>0;
  return hash>>>0;
}
function pluginAction(name,args){
  return Pebble.invokeAction({plugin:HA_PLUGIN_UUID,action:name,args:args});
}
function pluginResult(result,context){
  if(!result||!result.ok)throw Error(context+': '+String(result&&result.message||'plugin call failed'));
  try{return JSON.parse(result.text||'{}');}
  catch(e){throw Error(context+': invalid plugin response');}
}

var MAX_PENDING_STREAM_SEGMENTS=8;
function waitForStreamRoom(gen){
  return new Promise(function(resolve,reject){
    function check(){
      if(gen!==requestGeneration){reject(Error('TTS cancelled'));return;}
      if(readyAudioQueue.length<MAX_PENDING_STREAM_SEGMENTS){resolve();return;}
      setTimeout(check,30);
    }
    check();
  });
}
function pluginStreamWav(sentence,gen,onPcm,prepared){
  var startedAt=Date.now(),preparedAt=0,session=null,expectedChecksum=0;
  var countSamples=0,prev1=0,prev2=0,rolling=2166136261>>>0;
  var firstPlaybackAt=0;
  function updateDebug(fields){
    var d={};
    try{d=JSON.parse(localStorage.getItem(PCM_DEBUG_STORAGE_KEY)||'{}');}catch(e){}
    for(var k in fields)if(Object.prototype.hasOwnProperty.call(fields,k))d[k]=fields[k];
    localStorage.setItem(PCM_DEBUG_STORAGE_KEY,JSON.stringify(d));
  }
  function useChunk(offset,bytes,expected,length){
    if(gen!==requestGeneration)throw Error('TTS cancelled');
    if(!Number.isInteger(expected) ||
       pluginWavChecksum(new Uint8Array(bytes))!==(expected>>>0))
      throw Error('Bridge WAV chunk checksum mismatch at '+offset);
    if((offset===0 && bytes.length<44) || (offset!==0 && offset%6000!==0))
      throw Error('Invalid streamed WAV chunk alignment');
    if(offset===0){
      function tag(at){return String.fromCharCode(bytes[at],bytes[at+1],bytes[at+2],bytes[at+3]);}
      if(tag(0)!=='RIFF'||tag(8)!=='WAVE'||tag(12)!=='fmt '||tag(36)!=='data'||
         (bytes[20]|bytes[21]<<8)!==1 ||
         (bytes[22]|bytes[23]<<8)!==1 ||
         (bytes[24]|bytes[25]<<8|bytes[26]<<16|bytes[27]<<24)!==8000 ||
         (bytes[34]|bytes[35]<<8)!==16)
        throw Error('Invalid canonical Bridge PCM WAV header');
    }
    for(var h=0;h<bytes.length;h++)rolling=Math.imul((rolling^bytes[h])>>>0,16777619)>>>0;
    var from=offset===0?44:0;
    if((bytes.length-from)%2)throw Error('Unaligned PCM16 chunk');
    var pcm=[];
    for(var i=from;i<bytes.length;i+=2){
      var sample=(bytes[i]|bytes[i+1]<<8);
      if(sample>32767)sample-=65536;
      var filtered=countSamples<2?sample:(sample+prev1+prev2)/3;
      pcm.push(filtered);
      prev2=prev1;prev1=sample;countSamples++;
    }
    if(pcm.length%2)throw Error('Odd PCM sample boundary in Bridge chunk');
    var last=offset+bytes.length===length;
    if(last && (rolling>>>0)!==expectedChecksum)
      throw Error('Bridge WAV final checksum mismatch');
    var audio=encodeADPCM(pcm);
    return waitForStreamRoom(gen).then(function(){
      if(!firstPlaybackAt){
        firstPlaybackAt=Date.now();
        updateDebug({first_audio_queued_ms:firstPlaybackAt-startedAt,
          transfer:'streaming verified PCM chunks to watch'});
      }
      return onPcm(audio,last);
    });
  }
  // Rolling three-request window. Fixed Promise.all batches had a barrier:
  // one slow request held up the next three, even when another completed.
  // Results are still decoded strictly in byte order, preserving the PCM
  // filter and IMA predictor state. Never retain more than three outstanding
  // offsets, even when the first of them is slow.
  function fetchParts(offset,length,step){
    return new Promise(function(resolve,reject){
      var nextRequest=offset,nextEmit=offset,active=0,draining=false;
      var finished=false,held={};
      function fail(error){
        if(finished)return;
        finished=true;reject(error);
      }
      function schedule(){
        if(finished)return;
        if(gen!==requestGeneration){fail(Error('TTS cancelled'));return;}
        while(active<3 && nextRequest<length &&
              nextRequest-nextEmit<step*3){
          (function(chunkOffset){
            nextRequest+=step;active++;
            pluginAction('tts_chunk',{
              session_id:session,offset:chunkOffset
            }).then(function(reply){
              active--;
              if(finished)return;
              var p=pluginResult(reply,'TTS chunk');
              var bytes=pluginDecodeBase64(String(p.audio||''));
              if(p.offset!==chunkOffset ||
                 bytes.length!==Math.min(step,length-chunkOffset))
                throw Error('Invalid streamed TTS audio chunk');
              held[chunkOffset]={offset:chunkOffset,bytes:bytes,
                checksum:p.checksum};
              drain();
              schedule();
            }).catch(fail);
          })(nextRequest);
        }
      }
      function drain(){
        if(finished||draining)return;
        if(gen!==requestGeneration){fail(Error('TTS cancelled'));return;}
        var part=held[nextEmit];
        if(!part){
          if(nextEmit>=length && active===0){
            finished=true;resolve();
          }
          return;
        }
        delete held[nextEmit];
        draining=true;
        useChunk(part.offset,part.bytes,part.checksum,length).then(function(){
          nextEmit+=part.bytes.length;
          draining=false;
          schedule();
          drain();
        }).catch(fail);
      }
      schedule();
      drain();
    });
  }
  return (prepared||pluginAction('tts_prepare',{text:sentence})).then(function(result){
    var meta=pluginResult(result,'TTS preparation');
    preparedAt=Date.now();
    if(meta.format!=='pcm_s16le_wav'||meta.sample_rate!==8000||
       meta.channels!==1||meta.bits_per_sample!==16||
       !Number.isInteger(meta.length)||meta.length<44||
       meta.length>1500000||meta.length%2!==0||
       !meta.session_id||!Number.isInteger(meta.wav_checksum))
      throw Error('Bridge streaming format mismatch');
    if(meta.length!==44+meta.sample_count*2)
      throw Error('Bridge streaming WAV length mismatch');
    expectedChecksum=meta.wav_checksum>>>0;
    session=String(meta.session_id);
    var step=meta.chunk_bytes||6000;
    if(step!==6000)throw Error('Unsupported streamed TTS chunk size');
    var d=meta.audio_diagnostics||{};
    d.timestamp=new Date().toISOString();
    d.transfer='streaming verified PCM chunks to watch';
    d.wav_length=meta.length;
    d.prepare_ms=preparedAt-startedAt;
    d.inlined_first_chunk=!!meta.first_chunk;
    d.progressive_playback=true;
    localStorage.setItem(PCM_DEBUG_STORAGE_KEY,JSON.stringify(d));
    if(typeof meta.first_chunk!=='string' ||
       !Number.isInteger(meta.first_chunk_checksum))
      throw Error('Bridge does not support verified streaming chunks; update Bridge');
    var first=pluginDecodeBase64(meta.first_chunk);
    if(first.length!==Math.min(step,meta.length))
      throw Error('Invalid first streamed WAV chunk');
    return useChunk(0,first,meta.first_chunk_checksum,meta.length).then(function(){
      return fetchParts(first.length,meta.length,step);
    });
  }).then(function(){
    updateDebug({transfer:'all streamed WAV chunks verified',
      chunk_transfer_ms:Date.now()-preparedAt,
      total_wav_ms:Date.now()-startedAt});
    if(session)pluginAction('tts_release',{session_id:session}).catch(function(){});
  },function(e){
    if(session)pluginAction('tts_release',{session_id:session}).catch(function(){});
    updateDebug({transfer:'stream failed',error:String(e&&e.message||e).slice(0,120)});
    throw e;
  });
}


function startPluginTTSFetchLoop(gen){
  if(gen!==requestGeneration||isFetchingTTS||
     (!sentenceQueue.length && !pluginPreparedSentence)||
     readyAudioQueue.length>=MAX_READY_AUDIO_SENTENCES){
    conversationMaybeCompleteAudio();return;
  }
  var selected=consumePreparedBridgeSentence(gen);
  if(!selected)return;
  isFetchingTTS=true;
  var sentence=selected.sentence,streamedAdpcm=0,startedNextPrep=false;
  pluginStreamWav(sentence,gen,function(audio,last){
    if(gen!==requestGeneration)throw Error('TTS cancelled');
    streamedAdpcm+=audio.length;
    // Prioritize the active sentence's first ~0.75 seconds (three 6KB
    // WAV chunks) before running another Home Assistant request. Prefetch
    // immediately for short sentences that end sooner than this threshold.
    // This keeps sentence overlap without competing with critical startup
    // chunk traffic.
    if(!startedNextPrep && (streamedAdpcm>=3000 || last)){
      startedNextPrep=true;
      prefetchNextBridgeSentence(gen);
    }
    // Segment boundaries are NOT sentence boundaries. The Bluetooth sender
    // must carry IMA predictor state continuously and emit sentence-end only
    // on the final verified WAV chunk.
    readyAudioQueue.push({bytes:audio,endSentence:last});
    if(!isSendingBLE)startBLESendLoop();
  },selected.prepared).then(function(){
    if(gen!==requestGeneration)return;
    isFetchingTTS=false;
    if(!isSendingBLE)startBLESendLoop();
    startPluginTTSFetchLoop(gen);
    conversationMaybeCompleteAudio();
  }).catch(function(error){
    if(gen!==requestGeneration)return;
    ++requestGeneration; // Invalidate any in-flight BLE packets.
    isFetchingTTS=false;isSendingBLE=false;
    readyAudioQueue=[];conversationAudioFinalPending=false;sentenceQueue=[];
    pluginPreparedSentence=null;
    console.log('Home Assistant plugin TTS: '+String(error.message||error));
    if(onError)onError(error);
    Pebble.sendAppMessage({COMMAND:'AUDIO_STOP'},function(){},function(){});
  });
}

var bleFlowGeneration=-1,bleFlowSent=0,bleFlowStartedAt=0;
var BLE_PLAYBACK_BPS=4000,BLE_PREBUFFER_BYTES=2800,BLE_SAFE_QUEUE_BYTES=9000;
function bleAudioQueueEstimate(now){
  if(!bleFlowStartedAt)return bleFlowSent;
  return Math.max(0,bleFlowSent-
    Math.max(0,now-bleFlowStartedAt)*BLE_PLAYBACK_BPS/1000);
}
function bleAudioWaitMs(nextSize,now){
  if(!bleFlowStartedAt)return 0;
  var excess=bleAudioQueueEstimate(now)+nextSize-BLE_SAFE_QUEUE_BYTES;
  return excess>0?Math.ceil(excess*1000/BLE_PLAYBACK_BPS):0;
}
function bleAudioAck(bytes,now){
  bleFlowSent+=bytes;
  if(!bleFlowStartedAt && bleFlowSent>=BLE_PREBUFFER_BYTES)
    bleFlowStartedAt=now;
}
function startBLESendLoop() {
  if (isSendingBLE) return; 
  if (readyAudioQueue.length === 0) {conversationMaybeCompleteAudio();return;} 
  
  isSendingBLE = true; 
  var nextSegment=readyAudioQueue.shift();
  var endSentence=Array.isArray(nextSegment) || nextSegment.endSentence===true;
  var adpcmBytes=Array.isArray(nextSegment)?nextSegment:nextSegment.bytes;
  // Opening a consumer slot lets the producer fetch/encode the next sentence
  // concurrently with Bluetooth playback. Both connection modes share this.
  startPluginTTSFetchLoop(requestGeneration);
  var cursor = 0;
  var failureCount = 0;
  var generation = requestGeneration;
  if(bleFlowGeneration!==generation){
    bleFlowGeneration=generation;
    bleFlowSent=0;
    bleFlowStartedAt=0;
  }
  function audioSendFailed() {
    if(generation!==requestGeneration)return;
    isSendingBLE=false;
    readyAudioQueue=[]; sentenceQueue=[]; isFetchingTTS=false;
    pluginPreparedSentence=null;
    conversationAudioFinalPending=false;
    ++requestGeneration; // invalidate any queued TTS delivery
    console.log('Pebble Bluetooth audio delivery failed after retries');
    if(onError)onError(Error('Bluetooth audio delivery failed'));
    Pebble.sendAppMessage({COMMAND:'AUDIO_STOP'},function(){},function(){});

  }
  function sendNextChunk() {
    if(generation!==requestGeneration)return;
    var previousCursor = cursor; 
    var chunk = [];              
    var chunkSize = 700;         

    for (var i = 0; i < chunkSize && cursor < adpcmBytes.length; i++, cursor++) {
      chunk.push(adpcmBytes[cursor]); 
    }

    if (chunk.length > 0) {
      // Rewind and retry later if transmitting this packet would exceed the
      // estimated safe send-ahead buffer. This is bounded pacing, not a
      // fixed per-packet penalty on top of Bluetooth acknowledgement time.
      var wait=bleAudioWaitMs(chunk.length,Date.now());
      if(wait>0){
        cursor=previousCursor;
        setTimeout(sendNextChunk,Math.max(10,wait));
        return;
      }
      Pebble.sendAppMessage(
        { 'COMMAND': 'AUDIO_CHUNK', 'CHUNK': chunk },
        function success() {
          if(generation!==requestGeneration)return;
          failureCount=0;
          bleAudioAck(chunk.length,Date.now());
          setTimeout(sendNextChunk,10);
        },
        function failure() {
          cursor=previousCursor;
          if(++failureCount>=5){audioSendFailed();return;}
          setTimeout(sendNextChunk, 250*failureCount);
        } 
      );
    } else {
      if(!endSentence){
        // More verified WAV chunks are still arriving. This is only a
        // transport segment boundary, not a pause between sentences.
        isSendingBLE=false;
        startBLESendLoop();
        return;
      }
      Pebble.sendAppMessage(
        { 'COMMAND': 'AUDIO_SENTENCE_END' },
        function() { 
            isSendingBLE = false; 
            // No fixed delay between complete spoken sentences: the watch
            // already has a PCM ring and double buffering to smooth handoff.
            startBLESendLoop();
            conversationMaybeCompleteAudio(); 
        },
        function() {
            if(++failureCount>=5){audioSendFailed();return;}
            setTimeout(sendNextChunk, 250*failureCount);
        }
      );
    }
  }
  sendNextChunk(); 
}

    function stop(){
      ++requestGeneration;
      sentenceQueue=[];readyAudioQueue=[];pluginPreparedSentence=null;
      isFetchingTTS=false;isSendingBLE=false;
      conversationAudioFinalPending=false;
      Pebble.sendAppMessage({COMMAND:'AUDIO_STOP'},function(){},function(){});
    }
    function speak(text){
      if(typeof text!=='string'||!text.trim())
        return Promise.reject(Error('Speech text must not be empty'));
      // Invalidate an existing stream before sending reset to the watch.
      ++requestGeneration;
      var gen=requestGeneration;
      sentenceQueue=[];readyAudioQueue=[];pluginPreparedSentence=null;
      isFetchingTTS=false;isSendingBLE=false;
      js_adpcm_valpred=0;js_adpcm_index=0;
      bleFlowGeneration=-1;bleFlowSent=0;bleFlowStartedAt=0;
      lastAnswer=text;
      sentenceQueue=[];
      // Bridge tts_prepare accepts up to 500 characters. Break up even long
      // unpunctuated responses without losing words or audio continuity.
      (text.match(/[^.!?]+[.!?]*/g)||[text]).forEach(function(piece){
        piece=piece.trim();
        while(piece.length>480){
          var cut=piece.lastIndexOf(' ',480);
          if(cut<200)cut=480;
          sentenceQueue.push(piece.substring(0,cut).trim());
          piece=piece.substring(cut).trim();
        }
        if(piece)sentenceQueue.push(piece);
      });
      conversationAudioFinalPending=true;
      return new Promise(function(resolve,reject){
        Pebble.sendAppMessage({COMMAND:'AUDIO_RESET'},function(){
          if(gen!==requestGeneration){reject(Error('Cancelled'));return;}
          startPluginTTSFetchLoop(gen);
          resolve();
        },function(){reject(Error('Failed to reset watch audio'));});
      });
    }
    function handleMessage(payload){
      if(!payload||payload.COMMAND!=='AUDIO_STATS')return false;
      var stats={timestamp:new Date().toISOString()};
      String(payload.TEXT||'').split(',').forEach(function(pair){
        var kv=pair.split('=');
        if(kv.length!==2||!/^(empty|empty_ms|partial|zero|peak|frames)$/.test(kv[0]))return;
        var n=Number(kv[1]);
        if(Number.isInteger(n)&&n>=0)stats[kv[0]]=n;
      });
      localStorage.setItem(PCM_DEBUG_STORAGE_KEY+'_WATCH',JSON.stringify(stats));
      if(onStats)onStats(stats);
      return true;
    }
    function diagnostics(){
      try{return JSON.parse(localStorage.getItem(PCM_DEBUG_STORAGE_KEY)||'null');}
      catch(e){return null;}
    }
    return {speak:speak,stop:stop,diagnostics:diagnostics,
      handleMessage:handleMessage};
  }
};
