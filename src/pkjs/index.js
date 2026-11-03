// Home Assistant AI for Pebble. All requests originate from the Pebble companion phone.
var Clay = require('pebble-clay');
var haUrl = localStorage.getItem('HA_URL') || '';
var haToken = localStorage.getItem('HA_TOKEN') || '';
var haAgent = localStorage.getItem('HA_AGENT') || '';
var haTts = localStorage.getItem('HA_TTS') || '';
var haConversationId = localStorage.getItem('HA_CONVERSATION_ID') || '';
var enableTts = localStorage.getItem('ENABLE_TTS') !== 'false';
var fontSize = parseInt(localStorage.getItem('FONT_SIZE') || '24', 10);
var watchInfo = null, hasSpeaker = false;
try {
  watchInfo = Pebble.getActiveWatchInfo();
  // Gabbro is Pebble 2 Duo (no speaker). Emery is Pebble Time 2.
  hasSpeaker = !!(watchInfo && watchInfo.platform === 'emery');
} catch (err) { hasSpeaker = false; }
var audioProfile = '8k-16b';
var lastAnswer = '';
var sentenceQueue = [], readyAudioQueue = [];
var isFetchingTTS = false, isSendingBLE = false, requestGeneration = 0;
var js_adpcm_valpred = 0, js_adpcm_index = 0;
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
var clayConfig = [
  {type:'heading',defaultValue:'Home Assistant AI'},
  {type:'section',items:[
    {type:'heading',defaultValue:'Connection'},
    {type:'input',messageKey:'HA_URL',label:'Home Assistant HTTPS URL',defaultValue:haUrl,
      description:'Public HTTPS root URL, no /api path',attributes:{type:'url',autocapitalize:'off',autocorrect:'off'}},
    {type:'input',messageKey:'HA_TOKEN',label:'Long-lived access token',
      description:haToken?'Token saved; leave blank to keep it':'Required; created in Home Assistant user profile',
      attributes:{type:'password',placeholder:haToken?'Saved; leave empty':'Paste token'}},
    {type:'input',messageKey:'HA_AGENT',label:'Conversation agent ID (optional)',defaultValue:haAgent,
      description:'Leave blank to use Home Assistant default. Example: conversation.home_assistant'}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Home Assistant Speech'},
    {type:'input',messageKey:'HA_TTS',label:'TTS entity ID',defaultValue:haTts,
      description:'Example: tts.piper. Required for spoken replies; uses the voice set on that HA entity.'},
    {type:'toggle',messageKey:'ENABLE_TTS',label:'Speak responses on watch',defaultValue:enableTts,
      description:'Only on speaker-equipped Pebbles. Always displays text.'},
    {type:'toggle',messageKey:'RESET_CHAT',label:'Start new conversation',defaultValue:false,
      description:'Clear stored Home Assistant conversation ID'}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Display'},
    {type:'slider',messageKey:'FONT_SIZE',label:'Font size',defaultValue:fontSize,min:14,max:28,step:2}
  ]},
  {type:'submit',defaultValue:'Save Settings'}
];
var clay = new Clay(clayConfig, null, {autoHandleEvents:false});
Pebble.addEventListener('showConfiguration',function() { Pebble.openURL(clay.generateUrl()); });
Pebble.addEventListener('webviewclosed',function(e) {
  if (!e || !e.response || e.response === 'CANCELLED') return;
  var s;
  try { s = JSON.parse(decodeURIComponent(e.response)); } catch(err) { return; }
  function saved(key, name) {
    if (s[key] && typeof s[key].value !== 'undefined') {
      localStorage.setItem(name, String(s[key].value));
      return String(s[key].value);
    }
    return localStorage.getItem(name) || '';
  }
  haUrl = saved('HA_URL','HA_URL').trim().replace(/\/+$/,'');
  if (s.HA_TOKEN && s.HA_TOKEN.value) {
    haToken = String(s.HA_TOKEN.value).trim();
    localStorage.setItem('HA_TOKEN',haToken);
  }
  var agentBefore = haAgent;
  haAgent = saved('HA_AGENT','HA_AGENT').trim();
  haTts = saved('HA_TTS','HA_TTS').trim();
  if (agentBefore !== haAgent || (s.RESET_CHAT && s.RESET_CHAT.value)) {
    haConversationId = '';
    localStorage.removeItem('HA_CONVERSATION_ID');
  }
  if (s.ENABLE_TTS) {
    enableTts = !!s.ENABLE_TTS.value;
    localStorage.setItem('ENABLE_TTS',enableTts?'true':'false');
  }
  if (s.FONT_SIZE) {
    fontSize = parseInt(s.FONT_SIZE.value,10) || 24;
    localStorage.setItem('FONT_SIZE',String(fontSize));
    Pebble.sendAppMessage({COMMAND:'UPDATE_FONT',FONT_SIZE:fontSize});
  }
});
Pebble.addEventListener('ready',function() {
  Pebble.sendAppMessage({COMMAND:'UPDATE_FONT',FONT_SIZE:fontSize});
});
function errText(message) {
  Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',TEXT:String(message).substring(0,250)});
}
function normalizeUrl() {
  var u=(haUrl||'').trim().replace(/\/+$/,'');
  if (!/^https:\/\/[^\s/]+/i.test(u)) throw Error('Use an HTTPS Home Assistant URL.');
  return u;
}
function haJson(path,payload) {
  return fetch(normalizeUrl()+path, {
    method:'POST',
    headers:{'Authorization':'Bearer '+haToken,'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  }).then(function(r) {
    if (!r.ok) throw Error('Home Assistant HTTP '+r.status);
    return r.json();
  });
}
Pebble.addEventListener('appmessage',function(e) {
  var d=e.payload;
  if (d.COMMAND !== 'DICTATION') return;
  if (!haUrl || !haToken) { errText('Set Home Assistant URL and token in settings.'); return; }
  if (!d.TEXT) {errText('No dictation captured.'); return;}
  var skipAudio=!hasSpeaker || !enableTts || !haTts || d.VOLUME === 0;
  askHomeAssistant(d.TEXT,skipAudio);
});
function askHomeAssistant(prompt,skipAudio) {
  var generation=++requestGeneration;
  sentenceQueue=[]; readyAudioQueue=[]; isFetchingTTS=false; isSendingBLE=false;
  js_adpcm_valpred=0; js_adpcm_index=0;
  var request={text:prompt,language:'en'};
  if(haAgent) request.agent_id=haAgent;
  if(haConversationId) request.conversation_id=haConversationId;
  haJson('/api/conversation/process',request).then(function(data) {
    if(generation!==requestGeneration) return;
    var speech=data && data.response && data.response.speech && data.response.speech.plain;
    var message=speech && speech.speech;
    if(typeof message!=='string' || !message.trim()) {
      errText('No spoken response from Home Assistant.');
      return;
    }
    if(data.conversation_id) {
      haConversationId=data.conversation_id;
      localStorage.setItem('HA_CONVERSATION_ID',haConversationId);
    }
    lastAnswer = message;
    Pebble.sendAppMessage({
      COMMAND:skipAudio?'TEXT_RESPONSE_NO_AUDIO':'TEXT_RESPONSE_8_16',
      TEXT:message.substring(0,1900)
    });
    if(!skipAudio) {
      sentenceQueue=(message.match(/[^.!?]+[.!?]*/g)||[message])
        .map(function(s){return s.trim();}).filter(function(s){return s.length>0;});
      startTTSFetchLoop(generation);
    }
  }).catch(function(err) {
    if(generation===requestGeneration) errText('HA: '+(err.message||err));
  });
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

function lowPassFilter(samples) {
  var filtered = []; 
  filtered[0] = samples[0]; 
  filtered[1] = samples[1]; 
  for (var i = 2; i < samples.length; i++) {
    filtered[i] = (samples[i] + samples[i - 1] + samples[i - 2]) / 3;
  }
  return filtered;
}


// WAV returned by Home Assistant's own TTS engine via /api/tts_get_url.
// Request PCM16 8 kHz mono; do not try to decode MP3/OGG as PCM.
// Home Assistant Cloud can stream WAV audio with RIFF/data lengths set to
// 0xFFFFFFFF (unknown until stream completion). XMLHttpRequest delivers the
// entire ArrayBuffer on load, so use the actual received length for that case.
function wavToPcm(bytes) {
  if(!bytes || !bytes.byteLength) throw Error('Empty TTS audio');
  var view=new DataView(bytes), len=view.byteLength;
  if(len<12 || readTag(view,0)!=='RIFF' || readTag(view,8)!=='WAVE')
    throw Error('TTS response is not WAV');
  var offset=12, fmt=null, chunk=null;
  while(offset+8<=len) {
    var id=readTag(view,offset), size=view.getUint32(offset+4,true), pos=offset+8;
    // 0xFFFFFFFF is a valid unknown-length placeholder in streamed WAVs.
    // It is not a literal request for 4 GiB of audio.
    var streamedSize=(size===0xFFFFFFFF);
    if(streamedSize) {
      if(id!=='data') throw Error('Unknown WAV chunk length');
      size=len-pos;
    } else if(size>len-pos) {
      throw Error('Truncated WAV: '+id);
    }
    if(id==='fmt ') {
      if(size<16) throw Error('Invalid WAV format');
      fmt={format:view.getUint16(pos,true),channels:view.getUint16(pos+2,true),
        rate:view.getUint32(pos+4,true),bits:view.getUint16(pos+14,true)};
    }
    if(id==='data') {
      chunk={start:pos,size:size};
      // The payload ends here for both bounded and streaming data chunks.
      break;
    }
    offset=pos+size+(size%2);
  }
  if(!fmt || !chunk || fmt.format!==1 || fmt.channels!==1 || fmt.bits!==16 ||
    fmt.rate!==8000) throw Error('HA must return mono 8kHz 16-bit PCM WAV');
  if(chunk.size<2) throw Error('Empty TTS PCM data');
  var n=Math.floor(chunk.size/2), pcm=new Array(n);
  for(var i=0;i<n;i++) pcm[i]=view.getInt16(chunk.start+i*2,true);
  return pcm;
}
function readTag(view,i) {
  return String.fromCharCode(view.getUint8(i),view.getUint8(i+1),view.getUint8(i+2),view.getUint8(i+3));
}
function fetchWav(path,gen) {
  return new Promise(function(resolve,reject) {
    var xhr=new XMLHttpRequest();
    var url;
    try {
      // Use returned path rather than HA's advertised absolute URL (may contain a LAN host).
      if(!/^\/api\/tts_proxy\//.test(path)) throw Error('Unexpected HA TTS path');
      url=normalizeUrl()+path;
    } catch(e) {reject(e);return;}
    xhr.open('GET',url,true);
    xhr.responseType='arraybuffer';
    xhr.setRequestHeader('Authorization','Bearer '+haToken);
    xhr.timeout=30000;
    xhr.onload=function() {
      if(gen!==requestGeneration) {reject(Error('Cancelled'));return;}
      if(xhr.status!==200) {reject(Error('TTS audio HTTP '+xhr.status));return;}
      try {resolve(wavToPcm(xhr.response));} catch(e) {reject(e);}
    };
    xhr.onerror=function(){reject(Error('TTS audio network error'));};
    xhr.ontimeout=function(){reject(Error('TTS audio timeout'));};
    xhr.send();
  });
}
function startTTSFetchLoop(gen) {
  if(gen!==requestGeneration || isFetchingTTS || !sentenceQueue.length) return;
  isFetchingTTS=true;
  var sentence=sentenceQueue.shift();
  haJson('/api/tts_get_url',{
    engine_id:haTts,
    message:sentence,
    cache:true,
    options:{preferred_format:'wav',preferred_sample_rate:8000,
      preferred_sample_channels:1,preferred_sample_bytes:2}
  }).then(function(data) {
    if(!data.path) throw Error('No TTS path');
    return fetchWav(data.path,gen);
  }).then(function(pcm) {
    if(gen!==requestGeneration) return;
    readyAudioQueue.push(encodeADPCM(lowPassFilter(pcm)));
    isFetchingTTS=false;
    if(!isSendingBLE) startBLESendLoop();
    startTTSFetchLoop(gen);
  }).catch(function(err) {
    if(gen!==requestGeneration) return;
    isFetchingTTS=false;
    // Keep the text response even when TTS generation fails.
    console.log('Home Assistant TTS error: '+String(err.message||err));
    sentenceQueue=[];
    // Preserve the AI text answer and clear the watch's buffering indicator.
    Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',TEXT:lastAnswer.substring(0,1900)});
  });
}
function startBLESendLoop() {
  if (isSendingBLE) return; 
  if (readyAudioQueue.length === 0) return; 
  
  isSendingBLE = true; 
  var adpcmBytes = readyAudioQueue.shift(); 
  var cursor = 0; 

  function sendNextChunk() {
    var previousCursor = cursor; 
    var chunk = [];              
    var chunkSize = 700;         

    for (var i = 0; i < chunkSize && cursor < adpcmBytes.length; i++, cursor++) {
      chunk.push(adpcmBytes[cursor]); 
    }

    if (chunk.length > 0) {
      Pebble.sendAppMessage(
        { 'COMMAND': 'AUDIO_CHUNK', 'CHUNK': chunk },
        function success() { setTimeout(sendNextChunk, 60); }, 
        function failure() { cursor = previousCursor; setTimeout(sendNextChunk, 200); } 
      );
    } else {
      Pebble.sendAppMessage(
        { 'COMMAND': 'AUDIO_SENTENCE_END' },
        function() { 
            isSendingBLE = false; 
            setTimeout(startBLESendLoop, 120); 
        },
        function() { 
            isSendingBLE = false;
            setTimeout(startBLESendLoop, 300); 
        }
      );
    }
  }
  sendNextChunk(); 
}