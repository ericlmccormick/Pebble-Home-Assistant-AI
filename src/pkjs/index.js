// Home Assistant AI for Pebble. All requests originate from the Pebble companion phone.
var Clay = require('pebble-clay');
var haUrl = localStorage.getItem('HA_URL') || '';
var haToken = localStorage.getItem('HA_TOKEN') || '';
var haAgent = localStorage.getItem('HA_AGENT') || '';
var haTts = localStorage.getItem('HA_TTS') || '';
var haPipeline = localStorage.getItem('HA_PIPELINE') || '';
var haConversationId = localStorage.getItem('HA_CONVERSATION_ID') || '';
var enableTts = localStorage.getItem('ENABLE_TTS') !== 'false';
var autoSend = localStorage.getItem('AUTO_SEND') !== 'false';
var textOnly = localStorage.getItem('TEXT_ONLY') === 'true';
var hapticLevel = localStorage.getItem('HAPTIC_LEVEL') || 'medium';
var hapticValues = {off:0,low:1,medium:2,high:3};
var fontSize = parseInt(localStorage.getItem('FONT_SIZE') || '24', 10);
var watchInfo = null, hasSpeaker = false;
try {
  watchInfo = Pebble.getActiveWatchInfo();
  // Gabbro is Pebble 2 Duo (no speaker). Emery is Pebble Time 2.
  hasSpeaker = !!(watchInfo && (watchInfo.platform === 'emery' || watchInfo.platform === 'flint'));
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
    {type:'input',messageKey:'HA_PIPELINE',label:'Speech-to-text / Assist pipeline',defaultValue:haPipeline,
      description:'Used by hands-free conversation mode. Choose the pipeline containing your desired STT engine; blank uses the preferred Assist pipeline.'},
    {type:'input',messageKey:'HA_AGENT',label:'Conversation agent (tap-to-talk)',defaultValue:haAgent,
      description:'Choose Google AI or another agent. Blank uses Home Assistant default; separate from the conversation-mode pipeline.'}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Home Assistant Speech'},
    {type:'input',messageKey:'HA_TTS',label:'Text-to-speech engine',defaultValue:haTts,
      description:'Speech playback entity, e.g. tts.home_assistant_cloud. Blank disables TTS.'},
    {type:'toggle',messageKey:'ENABLE_TTS',label:'Speak responses on watch',defaultValue:enableTts,
      description:'Only on speaker-equipped Pebbles. Always displays text.'},
    {type:'toggle',messageKey:'TEXT_ONLY',label:'Text-only responses',defaultValue:textOnly,
      description:'Never play spoken responses, even if TTS is configured.'},
    {type:'toggle',messageKey:'AUTO_SEND',label:'Send speech without confirmation',defaultValue:autoSend,
      description:'Send recognized words automatically; show them while waiting. Native speech error dialogs remain enabled.'},
    {type:'toggle',messageKey:'RESET_CHAT',label:'Start new conversation',defaultValue:false,
      description:'Clear stored Home Assistant conversation ID'}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Display'},
    {type:'slider',messageKey:'FONT_SIZE',label:'Font size',defaultValue:fontSize,min:14,max:28,step:2},
    {type:'select',messageKey:'HAPTIC_LEVEL',label:'Vibration feedback',defaultValue:hapticLevel,
      description:'A sample pulse plays on the watch after you save a new level.',
      options:[{label:'Off',value:'off'},{label:'Low - short',value:'low'},
               {label:'Medium - double',value:'medium'},{label:'High - long',value:'high'}]}
  ]},
  {type:'submit',defaultValue:'Save Settings'}
];
// Build dropdowns from the connected Home Assistant instance whenever the
// settings page opens. Keep the original input controls as an offline fallback.
var clay = new Clay(clayConfig, null, {autoHandleEvents:false});
var configDiscoveryGeneration=0;

function configField(key) {
  for(var i=0;i<clayConfig.length;i++) {
    var section=clayConfig[i];
    if(!section.items)continue;
    for(var j=0;j<section.items.length;j++)
      if(section.items[j].messageKey===key)return section.items[j];
  }
  return null;
}
function configLabel(state) {
  var friendly=state.attributes && state.attributes.friendly_name;
  return String(friendly||state.entity_id)+' ('+state.entity_id+')';
}
function configOptionsForDomain(states,domain,current,includeDefault) {
  var options=includeDefault?[{label:'Use Home Assistant default',value:''}]:[];
  var ids={};
  for(var i=0;i<states.length;i++) {
    var state=states[i],id=state && state.entity_id;
    if(typeof id!=='string' || id.indexOf(domain+'.')!==0 || ids[id])continue;
    ids[id]=true;
    options.push({label:configLabel(state),value:id});
  }
  options.sort(function(a,b){
    if(includeDefault && (!a.value||!b.value))return a.value?1:-1;
    return a.label.localeCompare(b.label);
  });
  if(current && !ids[current])
    options.push({label:'Previously selected: '+current,value:current});
  return options;
}
function configUseSelect(key,options,current) {
  var field=configField(key);
  if(!field || !options || !options.length)return;
  field.type='select';
  field.options=options;
  field.defaultValue=current;
  delete field.attributes;
}
function configUseInput(key,current) {
  var field=configField(key);
  if(!field)return;
  field.type='input';
  field.defaultValue=current;
  delete field.options;
}
function configApplyEntities(states) {
  if(!Array.isArray(states))throw Error('Unexpected /api/states response');
  var agents=configOptionsForDomain(states,'conversation',haAgent,true);
  var engines=configOptionsForDomain(states,'tts',haTts,true);
  if(agents.length>1 || haAgent)configUseSelect('HA_AGENT',agents,haAgent);
  if(engines.length>1 || haTts)configUseSelect('HA_TTS',engines,haTts);
}
function configApplyPipelines(result) {
  if(!result || !Array.isArray(result.pipelines))throw Error('Unexpected Assist pipeline list');
  var options=[{label:'Preferred Home Assistant pipeline',value:''}];
  var found={};
  for(var i=0;i<result.pipelines.length;i++) {
    var p=result.pipelines[i];
    if(!p || !p.id || found[p.id])continue;
    found[p.id]=true;
    var parts=[p.name||p.id];
    if(p.stt_engine)parts.push('STT: '+p.stt_engine);
    if(p.conversation_engine)parts.push('AI: '+p.conversation_engine);
    options.push({label:parts.join(' — '),value:p.id});
  }
  if(haPipeline && !found[haPipeline])
    options.push({label:'Previously selected: '+haPipeline,value:haPipeline});
  if(options.length>1 || haPipeline)configUseSelect('HA_PIPELINE',options,haPipeline);
}
function configListPipelines() {
  return new Promise(function(resolve,reject) {
    var ws,completed=false,timer;
    function done(error,result) {
      if(completed)return;
      completed=true;
      if(timer)clearTimeout(timer);
      if(ws) {
        ws.onmessage=null;ws.onopen=null;ws.onerror=null;ws.onclose=null;
        try{ws.close();}catch(e){}
      }
      if(error)reject(error);else resolve(result);
    }
    try {
      var url=normalizeUrl().replace(/^https:/i,'wss:')+'/api/websocket';
      ws=new WebSocket(url);
      timer=setTimeout(function(){done(Error('Pipeline discovery timed out'));},3500);
      ws.onmessage=function(e) {
        var m;
        try{m=JSON.parse(e.data);}catch(ex){done(ex);return;}
        if(m.type==='auth_required')
          ws.send(JSON.stringify({type:'auth',access_token:haToken}));
        else if(m.type==='auth_invalid')done(Error('Home Assistant authentication failed'));
        else if(m.type==='auth_ok')
          ws.send(JSON.stringify({id:9162,type:'assist_pipeline/pipeline/list'}));
        else if(m.type==='result' && m.id===9162) {
          if(m.success)done(null,m.result);
          else done(Error('Assist pipeline listing refused'));
        }
      };
      ws.onerror=function(){done(Error('Pipeline discovery socket failed'));};
      ws.onclose=function(){done(Error('Pipeline discovery disconnected'));};
    } catch(error){done(error);}
  });
}
function configLoadThenOpen() {
  var generation=++configDiscoveryGeneration;
  // Always refresh the defaults. A previous dropdown must never hide a
  // missing provider after the HA instance or credentials change.
  configUseInput('HA_AGENT',haAgent);
  configUseInput('HA_TTS',haTts);
  configUseInput('HA_PIPELINE',haPipeline);
  if(!haUrl || !haToken) {
    clay=new Clay(clayConfig,null,{autoHandleEvents:false});
    Pebble.openURL(clay.generateUrl());return;
  }
  var statesPromise=fetch(normalizeUrl()+'/api/states',{
    method:'GET',headers:{Authorization:'Bearer '+haToken}
  }).then(function(r){
    if(!r.ok)throw Error('Entity discovery HTTP '+r.status);
    return r.json();
  }).then(function(states){
    if(generation===configDiscoveryGeneration)configApplyEntities(states);
  }).catch(function(e){console.log('HA entity dropdown discovery: '+e.message);});
  var pipelinesPromise=configListPipelines().then(function(result){
    if(generation===configDiscoveryGeneration)configApplyPipelines(result);
  }).catch(function(e){console.log('HA pipeline dropdown discovery: '+e.message);});
  // Allow slow/offline HA to fail gracefully while preserving manual inputs.
  Promise.all([statesPromise,pipelinesPromise]).then(function() {
    if(generation!==configDiscoveryGeneration)return;
    clay=new Clay(clayConfig,null,{autoHandleEvents:false});
    Pebble.openURL(clay.generateUrl());
  });
}
Pebble.addEventListener('showConfiguration',configLoadThenOpen);
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
  haPipeline = saved('HA_PIPELINE','HA_PIPELINE').trim();
  conversationPipeline=haPipeline;
  if (agentBefore !== haAgent || (s.RESET_CHAT && s.RESET_CHAT.value)) {
    haConversationId = '';
    localStorage.removeItem('HA_CONVERSATION_ID');
  }
  if (s.ENABLE_TTS) {
    enableTts = !!s.ENABLE_TTS.value;
    localStorage.setItem('ENABLE_TTS',enableTts?'true':'false');
  }
  if (s.TEXT_ONLY) {
    textOnly=!!s.TEXT_ONLY.value;
    localStorage.setItem('TEXT_ONLY',textOnly?'true':'false');
  }
  if (s.AUTO_SEND) {
    autoSend=!!s.AUTO_SEND.value;
    localStorage.setItem('AUTO_SEND',autoSend?'true':'false');
  }
  var preview=false;
  if (s.HAPTIC_LEVEL && hapticValues.hasOwnProperty(String(s.HAPTIC_LEVEL.value))) {
    var selected=String(s.HAPTIC_LEVEL.value);
    preview=selected!==hapticLevel;
    hapticLevel=selected;
    localStorage.setItem('HAPTIC_LEVEL',hapticLevel);
  }
  if (s.FONT_SIZE) {
    fontSize=parseInt(s.FONT_SIZE.value,10) || 24;
    localStorage.setItem('FONT_SIZE',String(fontSize));
  }
  sendWatchSettings(preview);
});
function sendWatchSettings(preview) {
  Pebble.sendAppMessage({
    COMMAND:'SETTINGS',FONT_SIZE:fontSize,
    AUTO_SEND:autoSend?1:0,HAPTIC_LEVEL:hapticValues[hapticLevel] || 0
  },function() {
    if(preview) Pebble.sendAppMessage({
      COMMAND:'HAPTIC_PREVIEW',HAPTIC_LEVEL:hapticValues[hapticLevel] || 0
    });
  },function(error){console.log('Watch settings delivery failed '+JSON.stringify(error));});
}
Pebble.addEventListener('ready',function() {sendWatchSettings(false);});
function errText(message) {
  Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',TEXT:String(message).substring(0,250)});
}
function normalizeUrl() {
  var u=(haUrl||'').trim().replace(/\/+$/,'');
  if (!/^https:\/\/[^\s/]+/i.test(u)) throw Error('Use an HTTPS Home Assistant URL.');
  return u;
}
// Never replay a timed-out device command: HA may already have acted on it.
function haDelay(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
function haRequestError(code) {
  var msg = code===401 || code===403 ? 'Home Assistant token rejected ('+code+')' :
    code===404 ? 'Home Assistant API or entity not found (404)' :
    code===429 ? 'Home Assistant is rate-limiting (429)' :
    code>=500 ? 'Home Assistant unavailable (HTTP '+code+')' : 'Home Assistant HTTP '+code;
  var e=Error(msg);e.status=code;return e;
}
function haJson(path,payload) {
  var safe=path==='/api/tts_get_url';
  function attempt(n) {
    return new Promise(function(resolve,reject) {
      var settled=false, maxTime=safe?14000:20000;
      var timer=setTimeout(function(){
        if(!settled){settled=true;reject(Error('Home Assistant timed out after '+(maxTime/1000)+' seconds')); }
      },maxTime);
      try {
        fetch(normalizeUrl()+path,{
          method:'POST',
          headers:{'Authorization':'Bearer '+haToken,'Content-Type':'application/json'},
          body:JSON.stringify(payload)
        }).then(function(r) {
          if(!r.ok)throw haRequestError(r.status);
          return r.json();
        }).then(function(data){
          if(!settled){settled=true;clearTimeout(timer);resolve(data);}
        }).catch(function(e){
          if(!settled){settled=true;clearTimeout(timer);
            reject(e && e.message ? e : Error('Cannot connect to Home Assistant'));}
        });
      }catch(e){if(!settled){settled=true;clearTimeout(timer);reject(e);}}
    }).catch(function(e) {
      var retryable=e && (e.status===429 ||
        (safe && (!e.status || e.status===502 || e.status===503 || e.status===504)));
      if(n<(safe?2:1) && retryable)
        return haDelay((n+1)*750).then(function(){return attempt(n+1);});
      throw e;
    });
  }
  return attempt(0);
}
// ------------------------------------------------------------------------
// SDK 110+ native microphone streaming. The Pebble phone app decodes Speex
// into PCM16LE and emits audiostreamstart/audiostream/audiostreamstop.
// Phone-side voice activity detection gates the Home Assistant Assist pipeline.
// ------------------------------------------------------------------------
var conversationSocket=null, conversationGeneration=0, conversationId=1001;
var conversationHandler=-1, conversationAudioQueue=[], conversationEnd=false;
var conversationAccepted=false, conversationReceivedText=false;
var conversationAudioFinalPending=false, conversationTimeout=null, conversationStage='';
var legacyConversationTurn=false;
var conversationFlushTimer=null;
var conversationPipeline=haPipeline;

function conversationStopSocket() {
  if(conversationTimeout){clearTimeout(conversationTimeout);conversationTimeout=null;}
  if(conversationFlushTimer){clearTimeout(conversationFlushTimer);conversationFlushTimer=null;}
  if(conversationSocket) {
    try {conversationSocket.onclose=null;conversationSocket.onerror=null;
      conversationSocket.onmessage=null;conversationSocket.close();}catch(e){}
  }
  conversationSocket=null;
  conversationHandler=-1;conversationAccepted=false;
  conversationAudioQueue=[];conversationEnd=false;
}
function conversationFailure(message, generation) {
  if(generation!==conversationGeneration)return;
  console.log('Home Assistant conversation: '+message);
  conversationStopSocket();
  sentenceQueue=[];readyAudioQueue=[];conversationAudioFinalPending=false;
  Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',TEXT:String(message).substring(0,180)},
    function(){Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});});
}
function conversationFlushAudio() {
  if(!conversationSocket || !conversationAccepted || conversationHandler<0)return;
  while(conversationAudioQueue.length) {
    if(conversationSocket.readyState!==1)return;
    // Backpressure: do not feed unlimited data into a busy WebSocket.
    if(conversationSocket.bufferedAmount>150000) {
      if(!conversationFlushTimer)
        conversationFlushTimer=setTimeout(function(){
          conversationFlushTimer=null;conversationFlushAudio();
        },40);
      return;
    }
    var frame=conversationAudioQueue.shift();
    var packet=new Uint8Array(frame.length+1);
    packet[0]=conversationHandler;packet.set(frame,1);
    conversationSocket.send(packet.buffer);
  }
  if(conversationEnd && !conversationAudioQueue.length && conversationSocket.readyState===1) {
    conversationSocket.send((new Uint8Array([conversationHandler])).buffer);
    conversationEnd=false;
    conversationHandler=-1;
  }
}
function conversationStart() {
  if(!haToken || !haUrl) {
    conversationFailure('Configure Home Assistant URL and token.',conversationGeneration);
    return;
  }
  conversationStopSocket();
  conversationReceivedText=false;
  var gen=++conversationGeneration; ++requestGeneration;
  sentenceQueue=[];readyAudioQueue=[];
  isFetchingTTS=false;isSendingBLE=false;
  var url;
  try{url=normalizeUrl().replace(/^https:/i,'wss:')+'/api/websocket';}
  catch(e){conversationFailure(e.message,gen);return;}
  var ws;
  try {ws=new WebSocket(url);}
  catch(e){conversationFailure('WebSocket unavailable: '+e.message,gen);return;}
  conversationSocket=ws;
  conversationStage='auth';
  conversationTimeout=setTimeout(function(){
    if(gen===conversationGeneration && !conversationReceivedText)
      conversationFailure('HA voice request timed out',gen);
  },35000);
  ws.onopen=function(){};
  ws.onclose=function() {
    if(gen===conversationGeneration && !conversationReceivedText)
      conversationFailure('HA voice socket closed',gen);
  };
  ws.onerror=function(){conversationFailure('HA voice socket error',gen);};
  ws.onmessage=function(event) {
    if(gen!==conversationGeneration)return;
    var msg;
    try{msg=JSON.parse(event.data);}catch(e){return;}
    if(msg.type==='auth_required'){
      ws.send(JSON.stringify({type:'auth',access_token:haToken}));
    } else if(msg.type==='auth_invalid') {
      conversationFailure('Home Assistant rejected token',gen);
    } else if(msg.type==='auth_ok') {
      var cmd={id:conversationId++,type:'assist_pipeline/run',
        start_stage:'stt',end_stage:'intent',input:{sample_rate:16000}};
      if(haConversationId)cmd.conversation_id=haConversationId;
      if(conversationPipeline)cmd.pipeline=conversationPipeline;
      conversationStage='starting';
      ws._haRunId=cmd.id;
      ws.send(JSON.stringify(cmd));
    } else if(msg.type==='result' && msg.id===ws._haRunId && !msg.success) {
      conversationFailure('HA Assist error: '+JSON.stringify(msg.error||{}).substring(0,90),gen);
    } else if(msg.type==='event' && msg.id===ws._haRunId) {
      var ev=msg.event||{},data=ev.data||{};
      if(ev.type==='run-start') {
        conversationHandler=data.runner_data && data.runner_data.stt_binary_handler_id;
        conversationAccepted=true;conversationStage='stt';
        conversationFlushAudio();
      } else if(ev.type==='stt-end') {
        conversationStage='intent';
        var recognized=data.stt_output && data.stt_output.text;
        if(recognized) Pebble.sendAppMessage({
          COMMAND:'CONV_TRANSCRIPT',TEXT:String(recognized).substring(0,220)
        });
      } else if(ev.type==='intent-end') {
        conversationReceivedText=true;
        if(conversationTimeout){clearTimeout(conversationTimeout);conversationTimeout=null;}
        var response=data.intent_output && data.intent_output.response;
        var speech=response && response.speech && response.speech.plain;
        var reply=speech && speech.speech;
        if(data.conversation_id) {
          haConversationId=data.conversation_id;
          localStorage.setItem('HA_CONVERSATION_ID',haConversationId);
        }
        if(response && response.conversation_id) {
          haConversationId=response.conversation_id;
          localStorage.setItem('HA_CONVERSATION_ID',haConversationId);
        }
        conversationStopSocket();
        conversationShowReply(String(reply||'No response from Home Assistant.'),gen);
      } else if(ev.type==='error') {
        conversationFailure('HA Assist: '+(data.message||data.code||'unknown error'),gen);
      } else if(ev.type==='run-end' && !conversationReceivedText) {
        conversationFailure('No speech recognized by Home Assistant',gen);
      }
    }
  };
}
// A small pre-roll prevents clipping the first syllable of a sentence.
// Do not send continuous room audio to Home Assistant while waiting for speech.
var nativeMicMode=false, nativeMicActive=false, nativeMicWaiting=false;
var nativeSpeechStarted=false, nativePreRoll=[], nativePreRollBytes=0;
var nativeVoicedMs=0, nativeSilenceMs=0, nativeTotalMs=0;
var nativeStopTimer=null;
var NATIVE_PCM_BYTES_PER_SECOND=32000;
function nativeResetTurn() {
  nativeMicActive=false;
  nativeMicWaiting=false;
  nativeSpeechStarted=false;
  nativePreRoll=[];nativePreRollBytes=0;
  nativeVoicedMs=0;nativeSilenceMs=0;nativeTotalMs=0;
  if(nativeStopTimer){clearTimeout(nativeStopTimer);nativeStopTimer=null;}
}
function nativeCancel() {
  nativeMicMode=false;
  nativeResetTurn();
  ++conversationGeneration;
  ++requestGeneration;
  conversationStopSocket();
  sentenceQueue=[];readyAudioQueue=[];
  conversationAudioFinalPending=false;
}
function nativeAudioRms(pcm) {
  if(pcm.length<2)return 0;
  var count=0,energy=0;
  for(var i=0;i+1<pcm.length;i+=2) {
    var sample=pcm[i] | (pcm[i+1]<<8);
    if(sample>32767)sample-=65536;
    energy+=sample*sample;
    count++;
  }
  return count?Math.sqrt(energy/count):0;
}
function nativeQueuePcm(pcm) {
  if(!conversationSocket || conversationReceivedText)return;
  if(conversationAudioQueue.length>=300) {
    conversationFailure('Microphone audio queue overflow',conversationGeneration);
    return;
  }
  conversationAudioQueue.push(pcm);
  conversationFlushAudio();
}
function nativeEndTurn() {
  if(!nativeMicMode || nativeMicWaiting)return;
  nativeMicWaiting=true;
  Pebble.sendAppMessage({COMMAND:'MIC_TURN_END'},function(){},
    function(){
      console.log('Unable to stop watch microphone');
      nativeCancel();
      Pebble.sendAppMessage({COMMAND:'MIC_MODE_OFF'});
    });
  nativeStopTimer=setTimeout(function(){
    nativeStopTimer=null;
    // A lost stop event must not leave Home Assistant waiting indefinitely.
    if(nativeMicWaiting && nativeMicMode) {
      conversationEnd=true;
      conversationFlushAudio();
    }
  },2500);
}
Pebble.addEventListener('audiostreamstart',function(e) {
  // The native audio transport can become ready before our AppMessage start
  // acknowledgement; receiving this event itself proves this app owns it.
  nativeMicMode=true;
  if(e.format && e.format!=='pcm16le') {
    console.log('Unsupported mic stream format: '+e.format);
    Pebble.sendAppMessage({COMMAND:'MIC_TURN_END'});
    return;
  }
  nativeResetTurn();
  if(e.sampleRate && Number(e.sampleRate)!==16000) {
    console.log('Unexpected mic sample rate: '+e.sampleRate);
    Pebble.sendAppMessage({COMMAND:'MIC_TURN_END'});
    return;
  }
  nativeMicActive=true;
});
Pebble.addEventListener('audiostream',function(e) {
  if(!nativeMicMode || nativeMicWaiting)return;
  if(!(e.data instanceof ArrayBuffer))return;
  if(!nativeMicActive)nativeMicActive=true;
  var pcm=new Uint8Array(e.data);
  if(pcm.length<2 || (pcm.length&1))return;
  var ms=pcm.length*1000/NATIVE_PCM_BYTES_PER_SECOND;
  var voice=nativeAudioRms(pcm)>=550;
  nativeTotalMs+=ms;
  if(!nativeSpeechStarted) {
    nativePreRoll.push(pcm);
    nativePreRollBytes+=pcm.length;
    while(nativePreRollBytes>12000 && nativePreRoll.length>1)
      nativePreRollBytes-=nativePreRoll.shift().length;
    nativeVoicedMs=voice?nativeVoicedMs+ms:0;
    if(nativeVoicedMs>=80) {
      nativeSpeechStarted=true;
      nativeSilenceMs=0;
      conversationStart();
      for(var i=0;i<nativePreRoll.length;i++)nativeQueuePcm(nativePreRoll[i]);
      nativePreRoll=[];nativePreRollBytes=0;
    }
    // Remain in listening mode through quiet periods. This is a deliberate
    // user-enabled session, not a 22-second voice recorder. The OS keeps
    // its Listening indicator active until the user explicitly stops.
    return;
  }
  nativeQueuePcm(pcm);
  if(voice)nativeSilenceMs=0;
  else nativeSilenceMs+=ms;
  if(nativeSilenceMs>=1400 || nativeTotalMs>=22000)nativeEndTurn();
});
Pebble.addEventListener('audiostreamstop',function() {
  if(!nativeMicMode)return;
  nativeMicActive=false;
  if(nativeStopTimer){clearTimeout(nativeStopTimer);nativeStopTimer=null;}
  if(nativeSpeechStarted && conversationSocket) {
    nativeMicWaiting=true;
    conversationEnd=true;
    conversationFlushAudio();
  } else if(!nativeMicWaiting) {
    // Notification, focus loss or phone rejection: do not restart blindly.
    Pebble.sendAppMessage({COMMAND:'MIC_MODE_OFF'});
    nativeCancel();
  } else {
    Pebble.sendAppMessage({
      COMMAND:'TEXT_RESPONSE_NO_AUDIO',TEXT:'No speech detected.'
    },function(){Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});});
  }
});
function conversationShowReply(reply,gen) {
  var canSpeak=hasSpeaker && enableTts && !textOnly && haTts;
  var cmd=canSpeak?'TEXT_RESPONSE_8_16':'TEXT_RESPONSE_NO_AUDIO';
  lastAnswer=reply;
  Pebble.sendAppMessage({COMMAND:cmd,TEXT:reply.substring(0,1900)},
    function() {
      if(gen!==conversationGeneration)return;
      if(canSpeak) {
        conversationAudioFinalPending=true;
        sentenceQueue=(reply.match(/[^.!?]+[.!?]*/g)||[reply])
          .map(function(s){return s.trim();})
          .filter(function(s){return !!s;});
        startTTSFetchLoop(requestGeneration);
      }else Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});
    },function(){console.log('Unable to send Assist answer to watch');}
  );
}
function conversationMaybeCompleteAudio() {
  if(!conversationAudioFinalPending || isFetchingTTS || isSendingBLE ||
    sentenceQueue.length || readyAudioQueue.length)return;
  conversationAudioFinalPending=false;
  Pebble.sendAppMessage({COMMAND:'CONV_AUDIO_END'});
}

Pebble.addEventListener('appmessage',function(e) {
  var d=e.payload;
  if(d.COMMAND==='MIC_MODE_ON'){
    nativeMicMode=true;
    if(!nativeMicActive)nativeResetTurn();
    return;
  }
  if(d.COMMAND==='MIC_MODE_OFF'){
    nativeCancel();return;
  }
  if (d.COMMAND !== 'DICTATION' && d.COMMAND !== 'CONV_DICTATION') return;
  var legacyTurn=d.COMMAND==='CONV_DICTATION';
  if (!haUrl || !haToken || !d.TEXT) {
    errText(!haUrl || !haToken ? 'Set Home Assistant URL and token.' : 'No dictation captured.');
    if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
    return;
  }
  var skipAudio=textOnly || !hasSpeaker || !enableTts || !haTts || d.VOLUME === 0;
  askHomeAssistant(d.TEXT,skipAudio,legacyTurn);
});
function askHomeAssistant(prompt,skipAudio,legacyTurn) {
  var generation=++requestGeneration;
  legacyConversationTurn=!!legacyTurn;
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
      if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
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
    },function(){
      if(generation!==requestGeneration)return;
      if(skipAudio) {
        if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});
      } else {
        if(legacyTurn)conversationAudioFinalPending=true;
        sentenceQueue=(message.match(/[^.!?]+[.!?]*/g)||[message])
          .map(function(s){return s.trim();}).filter(function(s){return s.length>0;});
        startTTSFetchLoop(generation);
      }
    },function(){
      if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
    });
  }).catch(function(err) {
    if(generation===requestGeneration) {
      errText('HA: '+(err.message||err));
      if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
    }
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
function fetchWav(path,gen,attempt) {
  attempt=attempt || 0;
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
      if(xhr.status!==200) {
        var e=Error('TTS audio HTTP '+xhr.status); e.status=xhr.status; reject(e);return;
      }
      try {resolve(wavToPcm(xhr.response));} catch(e) {reject(e);}
    };
    xhr.onerror=function(){reject(Error('TTS audio network error'));};
    xhr.ontimeout=function(){reject(Error('TTS audio timeout'));};
    xhr.send();
  }).catch(function(e) {
    // Fetching generated audio is safe to retry; it cannot operate any HA devices.
    var retryable=!e.status || e.status===429 || e.status===502 ||
                  e.status===503 || e.status===504;
    if(attempt<2 && retryable && gen===requestGeneration)
      return haDelay(600*(attempt+1)).then(function(){return fetchWav(path,gen,attempt+1);});
    throw e;
  });
}
function startTTSFetchLoop(gen) {
  if(gen!==requestGeneration || isFetchingTTS || !sentenceQueue.length) {
    conversationMaybeCompleteAudio();return;
  }
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
    conversationMaybeCompleteAudio();
  }).catch(function(err) {
    if(gen!==requestGeneration) return;
    isFetchingTTS=false;
    conversationAudioFinalPending=false;
    // Keep the text response even when TTS generation fails.
    console.log('Home Assistant TTS error: '+String(err.message||err));
    sentenceQueue=[];
    // Preserve the AI text answer and clear the watch's buffering indicator.
    Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',TEXT:lastAnswer.substring(0,1900)},
      function(){Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});});
  });
}
function startBLESendLoop() {
  if (isSendingBLE) return; 
  if (readyAudioQueue.length === 0) {conversationMaybeCompleteAudio();return;} 
  
  isSendingBLE = true; 
  var adpcmBytes = readyAudioQueue.shift(); 
  var cursor = 0;
  var failureCount = 0;
  var generation = requestGeneration;
  function audioSendFailed() {
    if(generation!==requestGeneration)return;
    isSendingBLE=false;
    readyAudioQueue=[]; sentenceQueue=[]; isFetchingTTS=false;
    conversationAudioFinalPending=false;
    ++requestGeneration; // invalidate any queued TTS delivery
    console.log('Pebble Bluetooth audio delivery failed after retries');
    Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',
      TEXT:lastAnswer.substring(0,1900)});
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
      Pebble.sendAppMessage(
        { 'COMMAND': 'AUDIO_CHUNK', 'CHUNK': chunk },
        function success() {
          failureCount=0;
          setTimeout(sendNextChunk, 60);
        },
        function failure() {
          cursor=previousCursor;
          if(++failureCount>=5){audioSendFailed();return;}
          setTimeout(sendNextChunk, 250*failureCount);
        } 
      );
    } else {
      Pebble.sendAppMessage(
        { 'COMMAND': 'AUDIO_SENTENCE_END' },
        function() { 
            isSendingBLE = false; 
            setTimeout(function(){startBLESendLoop();conversationMaybeCompleteAudio();}, 120); 
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