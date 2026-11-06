// Home Assistant AI for Pebble. All requests originate from the Pebble companion phone.
var Clay = require('pebble-clay');
var haUrl = localStorage.getItem('HA_URL') || '';
var haToken = localStorage.getItem('HA_TOKEN') || '';
var haAgent = localStorage.getItem('HA_AGENT') || '';
var haTts = localStorage.getItem('HA_TTS') || '';
var haPipeline = localStorage.getItem('HA_PIPELINE') || '';
var haConversationId = localStorage.getItem('HA_CONVERSATION_ID') || '';
// Existing users keep their saved mode. New installations use the plugin.
var useHaPlugin = localStorage.getItem('USE_HA_PLUGIN') !== 'false';
var HA_PLUGIN_UUID = 'a74370b6-929c-4ec0-b7ee-2fc6fca8db57';
var enableTts = localStorage.getItem('ENABLE_TTS') !== 'false';
// One-time migration: old Text-only setting overrode Speak responses.
// Preserve that effective preference before dropping the redundant key.
if (localStorage.getItem('TEXT_ONLY') === 'true') {
  enableTts = false;
  localStorage.setItem('ENABLE_TTS','false');
}
localStorage.removeItem('TEXT_ONLY');
var autoSend = localStorage.getItem('AUTO_SEND') !== 'false';
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
// Gemini's producer/consumer model: synthesize the next sentence while the
// current sentence plays. Keep only two compressed sentences queued so long
// responses never monopolize the phone's JS heap.
var sentenceQueue = [], readyAudioQueue = [];
var MAX_READY_AUDIO_SENTENCES=2;
// Bridge prepare runs one sentence ahead, but WAV chunk decode and ADPCM
// encoding stay serial so predictor/filter state never interleaves sentences.
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
// Clay can serialize toggle values as booleans, strings or numbers.
// Boolean('false') is true, so normalize explicitly on every boundary.
function clayBoolean(value, fallback) {
  if(value===true||value===1||value==='true'||value==='1'||value==='on')return true;
  if(value===false||value===0||value==='false'||value==='0'||value==='off')return false;
  return !!fallback;
}
var clayConfig = [
  {type:'heading',defaultValue:'Home Assistant AI'},
  // Top-level mode switch: plugin is the default. Clay shows direct fields
  // immediately when the user enables the built-in connection.
  {type:'section',items:[
    {type:'heading',defaultValue:'Connection Mode'},
    {type:'toggle',messageKey:'USE_BUILTIN_CONNECTION',label:'Use built-in connection',defaultValue:!useHaPlugin,
      description:'Off (default): plugin handles conversations and speech generation. On: use built-in Home Assistant URL/token. Continuous voice streaming is currently supported only in built-in mode.'}
  ]},
  {type:'section',items:[
    {type:'heading',id:'builtin_connection_heading',defaultValue:'Built-in Connection (continuous voice)'},
    {type:'input',messageKey:'HA_URL',label:'Home Assistant HTTPS URL',defaultValue:haUrl,
      description:'Public HTTPS root URL, no /api path',attributes:{type:'url',autocapitalize:'off',autocorrect:'off'}},
    {type:'input',messageKey:'HA_TOKEN',label:'Long-lived access token',
      description:haToken?'Token saved; leave blank to keep it':'Required; created in Home Assistant user profile',
      attributes:{type:'password',placeholder:haToken?'Saved; leave empty':'Paste token'}},
    {type:'input',messageKey:'HA_PIPELINE',label:'Speech-to-text / Assist pipeline',defaultValue:haPipeline,
      description:'Used by hands-free conversation mode. Choose the pipeline containing your desired STT engine; blank uses the preferred Assist pipeline.'},
    {type:'input',messageKey:'HA_AGENT',label:'Conversation agent (tap-to-talk)',defaultValue:haAgent,
      description:'Choose Google AI or another agent. Blank uses Home Assistant default; separate from the conversation-mode pipeline.'},
    {type:'input',messageKey:'HA_TTS',label:'Text-to-speech engine',defaultValue:haTts,
      description:'Speech playback entity, e.g. tts.home_assistant_cloud. Blank disables TTS.'}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Home Assistant Speech'},
    {type:'toggle',messageKey:'ENABLE_TTS',label:'Speak responses on watch',defaultValue:enableTts,
      description:'On: display text and play spoken responses when TTS is configured. Off: text only.'},
    {type:'toggle',messageKey:'AUTO_SEND',label:'Send speech without confirmation',defaultValue:autoSend,
      description:'Send recognized words automatically; show them while waiting. Native speech error dialogs remain enabled.'},
    {type:'toggle',messageKey:'TEST_HA_TTS_16K',label:'Test Home Assistant TTS (16 kHz source)',defaultValue:false,
      description:'On Save: synthesize a known spoken phrase from the selected Bridge TTS engine with cache off and 16 kHz PCM requested, then resample through the bridge and play. Compare with normal 8 kHz TTS.'},
    {type:'toggle',messageKey:'TEST_BRIDGE_AUDIO',label:'Test audio through bridge (440 Hz)',defaultValue:false,
      description:'On Save: retrieve a reference tone using the bridge WAV/session/chunk interface and play it through the normal Gemini encoder and Pebble speaker, without calling Home Assistant TTS.'},
    {type:'toggle',messageKey:'TEST_AUDIO_PATH',label:'Test watch audio (440 Hz tone)',defaultValue:false,
      description:'On Save: send a synthetic 440 Hz test tone through the same Gemini ADPCM and Bluetooth playback pipeline, without contacting Home Assistant. Helps isolate static to the watch or upstream audio.'},
    {type:'toggle',messageKey:'RESET_CHAT',label:'Start new conversation',defaultValue:false,
      description:'Clear stored Home Assistant conversation ID'}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Last Bridge TTS diagnostics (built-in requests not recorded)'},
    {type:'text',id:'pcm_debug_display',
      defaultValue:'No TTS diagnostics captured yet. Ask Home Assistant a question, then reopen these settings.'}
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
// Runs inside the Clay configuration page, not PebbleKit JS. Each local
// input is hidden on load in plugin mode, and shown as soon as the toggle
// changes. This keeps entered values intact while switching modes.
function connectionModeClay() {
  var page=this;
  page.on(page.EVENTS.AFTER_BUILD,function() {
    var toggle=page.getItemByMessageKey('USE_BUILTIN_CONNECTION');
    var fields=['HA_URL','HA_TOKEN','HA_PIPELINE','HA_AGENT','HA_TTS'];
    var heading=page.getItemById('builtin_connection_heading');
    function updateVisibility() {
      // This callback runs inside the Clay webview, without PebbleKit globals.
      var raw=toggle.get();
      var show=raw===true||raw===1||raw==='true'||raw==='1'||raw==='on';
      if(heading)heading[show?'show':'hide']();
      fields.forEach(function(key) {
        var item=page.getItemByMessageKey(key);
        if(item)item[show?'show':'hide']();
      });
    }
    if(toggle) {
      updateVisibility();
      toggle.on('change',updateVisibility);
    }
  });
}
var clay = new Clay(clayConfig, connectionModeClay, {autoHandleEvents:false});
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
// Keep the diagnostic on the phone; opening settings displays the last speech
// request without requiring a Pebble CLI, computer, or access to log files.
var PCM_DEBUG_STORAGE_KEY='HA_PCM_DIAGNOSTICS_V1';
function formatPcmDiagnostics() {
  var data=localStorage.getItem(PCM_DEBUG_STORAGE_KEY);
  if(!data)return 'No TTS diagnostics captured yet. Ask Home Assistant a question and reopen Settings.';
  try {
    var o=JSON.parse(data);
    var lines=['Current connection: '+(useHaPlugin?'Bridge plugin':'Built-in direct'),
      'These measurements are from the most recent Bridge request only.',
      'Captured: '+String(o.timestamp||'unknown'),
      'Transfer: '+String(o.transfer||'pending')];
    if(o.source)lines.push('Source: '+o.source);
    if(o.engine_id)lines.push('Bridge TTS engine: '+o.engine_id);
    if(o.binary_transport)lines.push('Bridge binary download: '+o.binary_transport);
    if(haTts)lines.push('Built-in TTS engine: '+haTts);
    if(o.requested_rate)lines.push('Requested rate: '+o.requested_rate+' Hz');
    if(o.input_rate)lines.push('Actual HA rate: '+o.input_rate+' Hz');
    if(o.input){
      lines.push('Input: peak '+o.input.peak+', RMS '+o.input.rms+
        ', clipped '+o.input.clipped+', crossings '+o.input.zero_crossings+
        ', duration '+o.input.duration_ms+' ms');
    }
    if(o.output){
      lines.push('8k output: peak '+o.output.peak+', RMS '+o.output.rms+
        ', clipped '+o.output.clipped+', crossings '+o.output.zero_crossings+
        ', duration '+o.output.duration_ms+' ms');
    }
    if(o.byte_order){
      var le=o.byte_order.little_endian,be=o.byte_order.big_endian;
      lines.push('PCM16 LE: mean step '+le.mean_step+
        ', RMS '+le.rms+', crossings '+le.crossings);
      lines.push('PCM16 BE: mean step '+be.mean_step+
        ', RMS '+be.rms+', crossings '+be.crossings);
      lines.push('Byte-order samples checked: '+o.byte_order.examined_samples);
    }
    if(o.declared_data_bytes!==undefined)
      lines.push('WAV data: declared '+o.declared_data_bytes+
        ' B; available '+o.available_data_bytes+
        ' B; used '+o.used_data_bytes+' B');
    if(o.wav_length)lines.push('WAV total length: '+o.wav_length+' B');
    if(o.stage_ms){
      lines.push('HA generation: '+o.stage_ms.ha_generation+' ms');
      lines.push('Bridge binary fetch: '+o.stage_ms.binary_download+' ms');
      lines.push('Bridge WAV parse: '+o.stage_ms.wav_parse+' ms');
      lines.push('Bridge resampling: '+o.stage_ms.resample+' ms');
      lines.push('Bridge WAV storage: '+o.stage_ms.session_storage+' ms');
      lines.push('Bridge processing total: '+o.stage_ms.total_bridge+' ms');
    }
    if(o.first_audio_queued_ms!==undefined)
      lines.push('First audio queued: '+o.first_audio_queued_ms+' ms');
    if(o.progressive_playback!==undefined)
      lines.push('Progressive transfer: '+(o.progressive_playback?'yes':'no'));
    if(o.prepare_ms!==undefined)
      lines.push('TTS prepare: '+o.prepare_ms+' ms');
    if(o.chunk_transfer_ms!==undefined)
      lines.push('WAV chunks: '+o.chunk_transfer_ms+' ms');
    if(o.total_wav_ms!==undefined)
      lines.push('Total WAV retrieval: '+o.total_wav_ms+' ms');
    if(o.inlined_first_chunk!==undefined)
      lines.push('Initial chunk in preparation: '+(o.inlined_first_chunk?'yes':'no'));
    if(o.error)lines.push('Error: '+o.error);
    // Clay text elements allow HTML; escape all received values.
    return '<div style="white-space:pre-wrap;word-break:break-word;font-size:13px">'+
      lines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;')+'</div>';
  } catch(e) {return 'Unable to display the last diagnostics. Please repeat a TTS request.';}
}
function refreshPcmDiagnostics() {
  for(var i=0;i<clayConfig.length;i++){
    var section=clayConfig[i];
    if(!section.items)continue;
    for(var j=0;j<section.items.length;j++){
      if(section.items[j].id==='pcm_debug_display')
        section.items[j].defaultValue=formatPcmDiagnostics();
    }
  }
}
function configLoadThenOpen() {
  refreshPcmDiagnostics();
  var modeItem=configField('USE_BUILTIN_CONNECTION');
  if(modeItem)modeItem.defaultValue=!useHaPlugin;
  var generation=++configDiscoveryGeneration;
  // Always refresh the defaults. A previous dropdown must never hide a
  // missing provider after the HA instance or credentials change.
  configUseInput('HA_AGENT',haAgent);
  configUseInput('HA_TTS',haTts);
  configUseInput('HA_PIPELINE',haPipeline);
  if(useHaPlugin || !haUrl || !haToken) {
    clay=new Clay(clayConfig,connectionModeClay,{autoHandleEvents:false});
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
    clay=new Clay(clayConfig,connectionModeClay,{autoHandleEvents:false});
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
  if (s.USE_BUILTIN_CONNECTION && typeof s.USE_BUILTIN_CONNECTION.value!=='undefined') {
    useHaPlugin=!clayBoolean(s.USE_BUILTIN_CONNECTION.value,!useHaPlugin);
    localStorage.setItem('USE_HA_PLUGIN',useHaPlugin?'true':'false');
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
  if (agentBefore !== haAgent || (s.RESET_CHAT && clayBoolean(s.RESET_CHAT.value,false))) {
    haConversationId = '';
    localStorage.removeItem('HA_CONVERSATION_ID');
  }
  if (s.ENABLE_TTS) {
    enableTts = clayBoolean(s.ENABLE_TTS.value,enableTts);
    localStorage.setItem('ENABLE_TTS',enableTts?'true':'false');
  }
  if (s.AUTO_SEND) {
    autoSend=clayBoolean(s.AUTO_SEND.value,autoSend);
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
  if(s.TEST_HA_TTS_16K && clayBoolean(s.TEST_HA_TTS_16K.value,false))runHATtsSourceTest();
  else if(s.TEST_BRIDGE_AUDIO && clayBoolean(s.TEST_BRIDGE_AUDIO.value,false))runBridgeAudioTest();
  else if(s.TEST_AUDIO_PATH && clayBoolean(s.TEST_AUDIO_PATH.value,false))runWatchAudioTest();
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
// Deliberate diagnostic only: exercises the unchanged Gemini 8kHz PCM16
// -> 3-sample filter -> 4-bit IMA ADPCM -> 700B BLE -> watch decoder path.
// A clean tone proves that chain can reproduce a known signal independently
// of Home Assistant and the bridge's WAV handling.
function runHATtsSourceTest(){
  if(!hasSpeaker){errText('This Pebble has no supported speaker');return;}
  if(!useHaPlugin){errText('Enable Home Assistant plugin mode for TTS source test');return;}
  var gen=++requestGeneration;
  sentenceQueue=[];readyAudioQueue=[];
  isFetchingTTS=true;isSendingBLE=false;
  js_adpcm_valpred=0;js_adpcm_index=0;
  conversationAudioFinalPending=false;
  lastAnswer='Home Assistant 16kHz source test: The quick brown fox jumps over the lazy dog.';
  Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_8_16',TEXT:lastAnswer},function(){
    if(gen!==requestGeneration)return;
    pluginFetchWav('The quick brown fox jumps over the lazy dog.',gen,false,{
      source_rate:16000,diagnostic:true}).then(function(pcm){
      if(gen!==requestGeneration)return;
      readyAudioQueue.push(encodeADPCM(lowPassFilter(pcm)));
      isFetchingTTS=false;
      startBLESendLoop();
    }).catch(function(err){
      if(gen!==requestGeneration)return;
      isFetchingTTS=false;
      errText('HA TTS 16k source test: '+String(err.message||err));
    });
  });
}
function runBridgeAudioTest(){
  if(!hasSpeaker){errText('This Pebble has no supported speaker');return;}
  if(!useHaPlugin){errText('Enable Home Assistant plugin mode to test bridge audio');return;}
  var gen=++requestGeneration;
  sentenceQueue=[];readyAudioQueue=[];
  isFetchingTTS=true;isSendingBLE=false;
  js_adpcm_valpred=0;js_adpcm_index=0;
  conversationAudioFinalPending=false;
  lastAnswer='Audio diagnostic: bridge-supplied 440 Hz reference tone (7 seconds).';
  Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_8_16',TEXT:lastAnswer},function(){
    if(gen!==requestGeneration)return;
    pluginFetchWav('',gen,true).then(function(pcm){
      if(gen!==requestGeneration)return;
      readyAudioQueue.push(encodeADPCM(lowPassFilter(pcm)));
      isFetchingTTS=false;
      startBLESendLoop();
    }).catch(function(err){
      if(gen!==requestGeneration)return;
      isFetchingTTS=false;
      errText('Bridge audio test: '+String(err.message||err));
    });
  });
}
function runWatchAudioTest(){
  if(!hasSpeaker){errText('This Pebble has no supported speaker');return;}
  var gen=++requestGeneration;
  sentenceQueue=[];readyAudioQueue=[];
  isFetchingTTS=false;isSendingBLE=false;
  js_adpcm_valpred=0;js_adpcm_index=0;
  conversationAudioFinalPending=false;
  lastAnswer='Audio diagnostic: 440 Hz reference tone (1.5 seconds).';
  var pcm=[];
  for(var i=0;i<12000;i++)
    pcm.push(Math.round(9000*Math.sin(2*Math.PI*440*i/8000)));
  readyAudioQueue.push(encodeADPCM(lowPassFilter(pcm)));
  Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_8_16',TEXT:lastAnswer},
    function(){if(gen===requestGeneration)startBLESendLoop();},
    function(err){console.log('Audio diagnostic setup failed '+JSON.stringify(err));});
}
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
  },120000);
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
        console.log('HA Assist STT completed, chars='+String(recognized||'').length);
        if(recognized) Pebble.sendAppMessage({
          COMMAND:'CONV_TRANSCRIPT',TEXT:String(recognized).substring(0,220)
        });
      } else if(ev.type==='intent-end') {
        conversationReceivedText=true;
        if(conversationTimeout){clearTimeout(conversationTimeout);conversationTimeout=null;}
        var response=data.intent_output && data.intent_output.response;
        var speech=response && response.speech && response.speech.plain;
        var reply=speech && speech.speech;
        console.log('HA Assist intent response type='+(response && response.response_type || 'unknown')+
          ', speech chars='+String(reply||'').length);
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
var nativeNoiseFloor=80, nativeLastRms=0;
var nativeStopTimer=null;
var NATIVE_PCM_BYTES_PER_SECOND=32000;
// Allow pauses while dictating a long request; the microphone stays live until the user finishes.
var NATIVE_END_SILENCE_MS=8000;
var NATIVE_MAX_SPEECH_MS=90000;
var NATIVE_MIN_UTTERANCE_MS=1200;
function nativeResetTurn() {
  nativeMicActive=false;
  nativeMicWaiting=false;
  nativeSpeechStarted=false;
  nativePreRoll=[];nativePreRollBytes=0;
  nativeVoicedMs=0;nativeSilenceMs=0;nativeTotalMs=0;
  nativeNoiseFloor=80;nativeLastRms=0;
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
  var rms=nativeAudioRms(pcm);
  // Calibrate quiet-room noise and use a lower, adaptive speech gate.
  // A fixed RMS 550 treated ordinary low-volume syllables as silence.
  if(!nativeSpeechStarted && rms<nativeNoiseFloor*2.5)
    nativeNoiseFloor=nativeNoiseFloor*0.98+rms*0.02;
  var voice=rms>=Math.max(180,Math.min(750,nativeNoiseFloor*3));
  nativeLastRms=rms;
  if(!nativeSpeechStarted) {
    nativePreRoll.push(pcm);
    nativePreRollBytes+=pcm.length;
    while(nativePreRollBytes>12000 && nativePreRoll.length>1)
      nativePreRollBytes-=nativePreRoll.shift().length;
    nativeVoicedMs=voice?nativeVoicedMs+ms:0;
    if(nativeVoicedMs>=80) {
      nativeSpeechStarted=true;
      // Count the spoken turn, not the time spent waiting for the user to speak.
      nativeTotalMs=0;
      nativeSilenceMs=0;
      console.log('Native mic: speech started');
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
  nativeTotalMs+=ms;
  if(voice)nativeSilenceMs=0;
  else nativeSilenceMs+=ms;
  // A short noise burst should not create a complete 3-second "utterance".
  // Avoid ending legitimate requests at natural pauses between clauses.
  if((nativeTotalMs>=NATIVE_MIN_UTTERANCE_MS &&
      nativeSilenceMs>=NATIVE_END_SILENCE_MS) ||
     nativeTotalMs>=NATIVE_MAX_SPEECH_MS) {
    console.log('Native mic: end of turn after '+Math.round(nativeTotalMs)+
      'ms speaking window; trailing silence '+Math.round(nativeSilenceMs)+
      'ms, last RMS '+Math.round(nativeLastRms)+
      ', speech gate '+Math.round(Math.max(180,Math.min(750,nativeNoiseFloor*3))));
    nativeEndTurn();
  }
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
  var canSpeak=hasSpeaker && enableTts && haTts;
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
    sentenceQueue.length || readyAudioQueue.length || pluginPreparedSentence)return;
  conversationAudioFinalPending=false;
  Pebble.sendAppMessage({COMMAND:'CONV_AUDIO_END'});
}

Pebble.addEventListener('appmessage',function(e) {
  var d=e.payload;
  if(d.COMMAND==='MIC_MODE_ON'){
    if(useHaPlugin){
      nativeCancel();
      Pebble.sendAppMessage({COMMAND:'MIC_MODE_OFF'},function(){
        errText('Hands-free streaming is not yet supported by the Pebble plugin API. Use Select for plugin-powered dictation.');
      });
      return;
    }
    nativeMicMode=true;
    if(!nativeMicActive)nativeResetTurn();
    return;
  }
  if(d.COMMAND==='MIC_MODE_OFF'){
    nativeCancel();return;
  }
  if (d.COMMAND !== 'DICTATION' && d.COMMAND !== 'CONV_DICTATION') return;
  var legacyTurn=d.COMMAND==='CONV_DICTATION';
  if ((!useHaPlugin && (!haUrl || !haToken)) || !d.TEXT) {
    errText(!useHaPlugin && (!haUrl || !haToken) ?
      'Set Home Assistant URL and token.' : 'No dictation captured.');
    if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
    return;
  }
  var skipAudio=!hasSpeaker || !enableTts || (!useHaPlugin && !haTts) || d.VOLUME === 0;
  askHomeAssistant(d.TEXT,skipAudio,legacyTurn);
});
// Plugin calls are request-scoped. Live PCM streaming remains on the direct
// PebbleKit JS -> Home Assistant Assist WebSocket until the plugin host offers
// streaming actions. Do not copy the plugin's private token into localStorage.
function askHomeAssistantViaPlugin(prompt,skipAudio,legacyTurn) {
  var generation=++requestGeneration;
  if(typeof Pebble.invokeAction!=='function') {
    errText('Plugins require the Pebble mobile app plugin preview.');
    if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
    return;
  }
  Pebble.invokeAction({
    plugin:HA_PLUGIN_UUID, action:'conversation',
    args:{text:prompt,agent_id:haAgent||undefined,conversation_id:haConversationId||undefined}
  }).then(function(result) {
    if(generation!==requestGeneration)return;
    if(!result||!result.ok)throw Error(result&&result.message||
      'Home Assistant plugin not installed or permission not granted');
    var data;
    try{data=JSON.parse(result.text||'{}');}
    catch(e){throw Error('Unexpected plugin conversation result');}
    if(data.conversation_id) {
      haConversationId=String(data.conversation_id);
      localStorage.setItem('HA_CONVERSATION_ID',haConversationId);
    }
    var answer=String(data.text||'No response from Home Assistant.');
    lastAnswer=answer;
    Pebble.sendAppMessage({COMMAND:skipAudio?'TEXT_RESPONSE_NO_AUDIO':'TEXT_RESPONSE_8_16',
      TEXT:answer.substring(0,1900)},function(){
      if(generation!==requestGeneration)return;
      if(skipAudio){if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});return;}
      legacyConversationTurn=!!legacyTurn;
      sentenceQueue=[];readyAudioQueue=[];isFetchingTTS=false;isSendingBLE=false;
      pluginPreparedSentence=null;
      js_adpcm_valpred=0;js_adpcm_index=0;
      if(legacyTurn)conversationAudioFinalPending=true;
      sentenceQueue=(answer.match(/[^.!?]+[.!?]*/g)||[answer])
        .map(function(s){return s.trim();}).filter(function(s){return !!s;});
      startPluginTTSFetchLoop(generation);
    });
  }).catch(function(error) {
    if(generation!==requestGeneration)return;
    errText('HA plugin: '+String(error.message||error).substring(0,185));
    if(legacyTurn)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
  });
}
function askHomeAssistant(prompt,skipAudio,legacyTurn) {
  if(useHaPlugin) {
    askHomeAssistantViaPlugin(prompt,skipAudio,legacyTurn);
    return;
  }
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
// All HA traffic in plugin mode goes through the plugin's scoped actions.
// Chunks are transferred as base64 because the preview action result is text.
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
// Match Gemini's default audio pipeline exactly: plugin supplies WAV
// containing signed 8kHz mono PCM16; the phone low-pass filters and encodes
// 4-bit IMA ADPCM, then sends 700-byte packets to the watch.
function pluginFetchWav(sentence,gen,testTone,options){
  var session=null,expectedChecksum=null;
  var startedAt=Date.now(),preparedAt=0;
  var args=testTone?{test_tone:true}:{text:sentence};
  if(options){
    if(options.source_rate)args.source_rate=options.source_rate;
    if(options.diagnostic)args.diagnostic=true;
  }
  return pluginAction('tts_prepare',args).then(function(result){
    var meta=pluginResult(result,'TTS preparation');
    preparedAt=Date.now();
    if(meta.format!=='pcm_s16le_wav'||meta.sample_rate!==8000||
       meta.channels!==1||meta.bits_per_sample!==16)
      throw Error('Bridge PCM WAV format mismatch: update Home Assistant Bridge');
    if(!meta.session_id||!Number.isInteger(meta.length)||meta.length<44||
       meta.length>1500000)
      throw Error('Invalid plugin TTS session');
    if(!Number.isInteger(meta.wav_checksum))
      throw Error('Bridge lacks WAV integrity metadata; update bridge');
    expectedChecksum=meta.wav_checksum>>>0;
    if(meta.audio_diagnostics){
      console.log('Bridge PCM diagnostics: '+JSON.stringify(meta.audio_diagnostics));
      var debug=meta.audio_diagnostics;
      debug.timestamp=new Date().toISOString();
      debug.transfer='retrieving WAV chunks';
      debug.wav_length=meta.length;
      debug.prepare_ms=preparedAt-startedAt;
      debug.inlined_first_chunk=!!meta.first_chunk;
      localStorage.setItem(PCM_DEBUG_STORAGE_KEY,JSON.stringify(debug));
    }
    session=String(meta.session_id);
    var length=meta.length,step=meta.chunk_bytes||6000;
    if(step!==6000)throw Error('Unsupported TTS chunk size');
    var data=new Uint8Array(length);
    var initialOffset=0;
    if(typeof meta.first_chunk==='string' && meta.first_chunk.length){
      var first=pluginDecodeBase64(meta.first_chunk);
      if(first.length!==Math.min(step,length))
        throw Error('Invalid bridge inlined first WAV chunk');
      data.set(first,0);
      initialOffset=first.length;
    }
    // Pebble launches one plugin action per WAV chunk. The original loop
    // waited for each action to restart/finish before requesting the next,
    // delaying the entire first sentence. Read three independent offsets
    // concurrently, with a bounded batch to avoid swamping the plugin host.
    function receiveBatch(offset){
      if(gen!==requestGeneration)throw Error('TTS cancelled');
      if(offset>=length)return data.buffer;
      var pending=[];
      var limit=Math.min(length,offset+step*3);
      for(var at=offset;at<limit;at+=step){
        (function(chunkOffset){
          pending.push(pluginAction('tts_chunk',{
            session_id:session,offset:chunkOffset
          }).then(function(reply){
            if(gen!==requestGeneration)throw Error('TTS cancelled');
            var part=pluginResult(reply,'TTS chunk');
            var bytes=pluginDecodeBase64(String(part.audio||''));
            if(part.offset!==chunkOffset||
               bytes.length!==Math.min(step,length-chunkOffset))
              throw Error('Invalid plugin TTS audio chunk');
            data.set(bytes,chunkOffset);
          }));
        })(at);
      }
      return Promise.all(pending).then(function(){
        return receiveBatch(limit);
      });
    }
    return receiveBatch(initialOffset);
  }).then(function(audio){
    if(session)pluginAction('tts_release',{session_id:session}).catch(function(){});
    var receivedChecksum=pluginWavChecksum(new Uint8Array(audio));
    var saved={};
    try{saved=JSON.parse(localStorage.getItem(PCM_DEBUG_STORAGE_KEY)||'{}');}catch(e){}
    if(receivedChecksum!==expectedChecksum){
      saved.transfer='FAILED: WAV checksum mismatch';
      localStorage.setItem(PCM_DEBUG_STORAGE_KEY,JSON.stringify(saved));
      throw Error('TTS chunk checksum mismatch (data corrupted during plugin transfer)');
    }
    saved.transfer='WAV checksum verified; PCM decoded';
    saved.chunk_transfer_ms=Date.now()-preparedAt;
    saved.total_wav_ms=Date.now()-startedAt;
    localStorage.setItem(PCM_DEBUG_STORAGE_KEY,JSON.stringify(saved));
    return wavToPcm(audio);
  },function(error){
    if(session)pluginAction('tts_release',{session_id:session}).catch(function(){});
    throw error;
  });
}

/**
 * Progressive downstream bridge playback.
 * The plugin host still buffers the upstream HTTP response (fetch has no
 * readable stream). Once the bridge prepares a session, each authenticated
 * 6000-byte chunk is verified and converted immediately to the existing
 * Gemini ADPCM stream; we never wait to reconstruct the entire WAV.
 */
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
  var sentence=selected.sentence,firstChunk=true;
  pluginStreamWav(sentence,gen,function(audio,last){
    if(gen!==requestGeneration)throw Error('TTS cancelled');
    if(firstChunk){
      firstChunk=false;
      // The current sentence has usable audio: begin preparing the next
      // sentence while its remaining chunks continue playing/transferring.
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
    Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',
      TEXT:(lastAnswer+'\\n\\nAudio error: '+String(error.message||error)).substring(0,1900)},
      function(){if(legacyConversationTurn)Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});});
  });
}
function startTTSFetchLoop(gen) {
  if(gen!==requestGeneration || isFetchingTTS || !sentenceQueue.length ||
     readyAudioQueue.length>=MAX_READY_AUDIO_SENTENCES) {
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
// Approximate the watch's ADPCM buffer occupancy from acknowledged BLE bytes
// and its 8 kHz / 4-bit = 4000 bytes/s decoder. Keep a modest safety margin
// below the physical 16 KiB ring. Never wait a fixed 175 ms after each ACK:
// that added BLE callback time on top of the audio transmission budget.
var bleFlowGeneration=-1,bleFlowSent=0,bleFlowStartedAt=0;
var BLE_PLAYBACK_BPS=4000,BLE_PREBUFFER_BYTES=2100,BLE_SAFE_QUEUE_BYTES=7500;
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
  if(useHaPlugin)startPluginTTSFetchLoop(requestGeneration);
  else startTTSFetchLoop(requestGeneration);
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