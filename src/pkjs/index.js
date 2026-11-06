// Home Assistant AI — Bridge-only Pebble app.
// Home Assistant credentials, conversation API, and TTS are owned by the
// Home Assistant Bridge plugin. Audio is the shared ha_audio.js SDK.
'use strict';
var Clay=require('pebble-clay');
var HA_PLUGIN_UUID='a74370b6-929c-4ec0-b7ee-2fc6fca8db57';
var hapticValues={off:0,low:1,medium:2,high:3};
var hapticLevel=localStorage.getItem('HAPTIC_LEVEL')||'medium';
var autoSend=localStorage.getItem('AUTO_SEND')!=='false';
var enableTts=localStorage.getItem('ENABLE_TTS')!=='false';
var fontSize=parseInt(localStorage.getItem('FONT_SIZE')||'24',10);
var conversationId=localStorage.getItem('HA_CONVERSATION_ID')||'';
var requestGeneration=0,legacyConversationTurn=false,lastAnswer='';
var hasSpeaker=false;
try{
  var info=Pebble.getActiveWatchInfo();
  hasSpeaker=!!info&&(info.platform==='emery'||info.platform==='flint');
}catch(e){}
// Do not retain credentials from versions that connected directly.
['HA_URL','HA_TOKEN','HA_AGENT','HA_TTS','HA_PIPELINE','USE_HA_PLUGIN'].forEach(function(key){
  localStorage.removeItem(key);
});
var audio=require('./ha_audio').create({
  Pebble:Pebble,storage:localStorage,pluginId:HA_PLUGIN_UUID,
  diagnosticsKey:'HA_AUDIO_LIBRARY_DIAG_V1',
  onError:function(e){
    var message='Audio error: '+String(e&&e.message||e).substring(0,155);
    console.log(message);
    Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',
      TEXT:(lastAnswer+'\n\n'+message).substring(0,1900)});
    if(legacyConversationTurn){
      legacyConversationTurn=false;
      Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});
    }
  },
  onComplete:function(){
    if(legacyConversationTurn){
      legacyConversationTurn=false;
      Pebble.sendAppMessage({COMMAND:'CONV_AUDIO_END'});
    }
  }
});
function valueBoolean(value,fallback){
  if(value===true||value===1||value==='true'||value==='1')return true;
  if(value===false||value===0||value==='false'||value==='0')return false;
  return !!fallback;
}
var clayConfig=[
  {type:'heading',defaultValue:'Home Assistant AI'},
  {type:'section',items:[
    {type:'heading',defaultValue:'Home Assistant Bridge required'},
    {type:'text',defaultValue:'Install and configure the Home Assistant Bridge plugin. This app uses the Bridge exclusively for conversations and speech; there is no direct connection or separate token.'},
    {type:'toggle',messageKey:'ENABLE_TTS',label:'Speak responses on watch',
      defaultValue:enableTts},
    {type:'toggle',messageKey:'AUTO_SEND',label:'Send dictation without confirmation',
      defaultValue:autoSend},
    {type:'toggle',messageKey:'RESET_CHAT',label:'Start new conversation',
      defaultValue:false}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Latest Bridge and watch audio diagnostics'},
    {type:'text',id:'pcm_debug_display',defaultValue:'Ask Home Assistant a question and reopen Settings.'}
  ]},
  {type:'section',items:[
    {type:'heading',defaultValue:'Display'},
    {type:'slider',messageKey:'FONT_SIZE',label:'Font size',
      defaultValue:fontSize,min:14,max:28,step:2},
    {type:'select',messageKey:'HAPTIC_LEVEL',label:'Vibration feedback',
      defaultValue:hapticLevel,
      options:[{label:'Off',value:'off'},{label:'Low - short',value:'low'},
        {label:'Medium - double',value:'medium'},{label:'High - long',value:'high'}]}
  ]},
  {type:'submit',defaultValue:'Save Settings'}
];
var clay=new Clay(clayConfig,null,{autoHandleEvents:false});
function diagnosticsText(){
  var d=audio.diagnostics(),watch=null;
  try{watch=JSON.parse(localStorage.getItem('HA_AUDIO_LIBRARY_DIAG_V1_WATCH')||'null');}catch(e){}
  var lines=['Connection: Home Assistant Bridge plugin'];
  if(!d)lines.push('No TTS request recorded yet.');
  else {
    lines.push('Captured: '+(d.timestamp||'unknown'));
    lines.push('Transfer: '+(d.transfer||'pending'));
    if(d.source)lines.push('Source: '+d.source);
    if(d.engine_id)lines.push('TTS engine: '+d.engine_id);
    if(d.stage_ms){
      lines.push('HA generation: '+d.stage_ms.ha_generation+' ms');
      lines.push('Binary fetch: '+d.stage_ms.binary_download+' ms');
      lines.push('WAV processing: '+d.stage_ms.total_bridge+' ms');
    }
    if(d.first_audio_queued_ms!==undefined)
      lines.push('First audio queued: '+d.first_audio_queued_ms+' ms');
    if(d.prepare_ms!==undefined)lines.push('TTS prepare: '+d.prepare_ms+' ms');
    if(d.chunk_transfer_ms!==undefined)lines.push('WAV chunks: '+d.chunk_transfer_ms+' ms');
    if(d.total_wav_ms!==undefined)lines.push('Total WAV: '+d.total_wav_ms+' ms');
    if(d.error)lines.push('Error: '+d.error);
  }
  if(watch){
    lines.push('Watch playback at '+watch.timestamp+':');
    lines.push('Empty events: '+watch.empty+'; empty ms: '+watch.empty_ms);
    lines.push('Partial writes: '+watch.partial+'; zero writes: '+watch.zero);
    lines.push('Peak ADPCM ring: '+watch.peak+' B');
  }
  return '<div style="white-space:pre-wrap;word-break:break-word;font-size:13px">'+
    lines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;')+'</div>';
}
Pebble.addEventListener('showConfiguration',function(){
  for(var i=0;i<clayConfig.length;i++){
    var section=clayConfig[i];
    if(!section.items)continue;
    section.items.forEach(function(item){
      if(item.id==='pcm_debug_display')item.defaultValue=diagnosticsText();
    });
  }
  clay=new Clay(clayConfig,null,{autoHandleEvents:false});
  Pebble.openURL(clay.generateUrl());
});
function sendWatchSettings(preview){
  Pebble.sendAppMessage({COMMAND:'SETTINGS',FONT_SIZE:fontSize,
    AUTO_SEND:autoSend?1:0,HAPTIC_LEVEL:hapticValues[hapticLevel]||0},
    function(){
      if(preview)Pebble.sendAppMessage({COMMAND:'HAPTIC_PREVIEW',
        HAPTIC_LEVEL:hapticValues[hapticLevel]||0});
    },function(err){console.log('Watch settings: '+JSON.stringify(err));});
}
Pebble.addEventListener('webviewclosed',function(e){
  if(!e||!e.response||e.response==='CANCELLED')return;
  var fields;
  try{fields=JSON.parse(decodeURIComponent(e.response));}catch(err){return;}
  function field(k){return fields[k]?fields[k].value:undefined;}
  if(field('ENABLE_TTS')!==undefined){
    enableTts=valueBoolean(field('ENABLE_TTS'),enableTts);
    localStorage.setItem('ENABLE_TTS',String(enableTts));
  }
  if(field('AUTO_SEND')!==undefined){
    autoSend=valueBoolean(field('AUTO_SEND'),autoSend);
    localStorage.setItem('AUTO_SEND',String(autoSend));
  }
  if(field('RESET_CHAT')!==undefined && valueBoolean(field('RESET_CHAT'),false)){
    conversationId='';localStorage.removeItem('HA_CONVERSATION_ID');
  }
  if(field('FONT_SIZE')!==undefined){
    fontSize=parseInt(field('FONT_SIZE'),10)||24;
    localStorage.setItem('FONT_SIZE',String(fontSize));
  }
  if(field('HAPTIC_LEVEL')!==undefined){
    var next=String(field('HAPTIC_LEVEL'));
    if(hapticValues.hasOwnProperty(next)){
      var preview=next!==hapticLevel;
      hapticLevel=next;localStorage.setItem('HAPTIC_LEVEL',next);
      sendWatchSettings(preview);return;
    }
  }
  sendWatchSettings(false);
});
Pebble.addEventListener('ready',function(){sendWatchSettings(false);});
function pluginAction(action,args){
  return Pebble.invokeAction({plugin:HA_PLUGIN_UUID,action:action,args:args});
}
function pluginJson(result){
  if(!result||!result.ok)
    throw Error(String(result&&result.message||'Home Assistant Bridge is unavailable or permission was denied'));
  try{return JSON.parse(result.text||'{}');}
  catch(e){throw Error('Invalid Home Assistant Bridge response');}
}
function replyError(message,legacy){
  audio.stop();
  Pebble.sendAppMessage({COMMAND:'TEXT_RESPONSE_NO_AUDIO',
    TEXT:String(message).substring(0,1900)},function(){
    if(legacy)Pebble.sendAppMessage({COMMAND:'CONV_MODE_STOP'});
  });
}
function askViaBridge(text,legacy){
  var gen=++requestGeneration;
  legacyConversationTurn=!!legacy;
  audio.stop();
  var args={text:String(text)};
  if(conversationId)args.conversation_id=conversationId;
  pluginAction('conversation',args).then(function(result){
    if(gen!==requestGeneration)return;
    var data=pluginJson(result);
    if(data.conversation_id){
      conversationId=String(data.conversation_id);
      localStorage.setItem('HA_CONVERSATION_ID',conversationId);
    }
    lastAnswer=String(data.text||'No spoken response returned by Home Assistant.');
    var speak=hasSpeaker&&enableTts;
    Pebble.sendAppMessage({
      COMMAND:speak?'TEXT_RESPONSE_8_16':'TEXT_RESPONSE_NO_AUDIO',
      TEXT:lastAnswer.substring(0,1900)
    },function(){
      if(gen!==requestGeneration)return;
      if(!speak){
        if(legacy)Pebble.sendAppMessage({COMMAND:'CONV_RESUME'});
        legacyConversationTurn=false;
        return;
      }
      audio.speak(lastAnswer).catch(function(e){
        if(gen===requestGeneration)replyError('Audio: '+String(e.message||e),legacy);
      });
    },function(){if(gen===requestGeneration)replyError('Watch response unavailable',legacy);});
  }).catch(function(e){
    if(gen===requestGeneration)replyError('Bridge: '+String(e.message||e),legacy);
  });
}
Pebble.addEventListener('appmessage',function(event){
  var d=event.payload||{};
  if(audio.handleMessage(d))return;
  if(d.COMMAND!=='DICTATION'&&d.COMMAND!=='CONV_DICTATION')return;
  var legacy=d.COMMAND==='CONV_DICTATION';
  if(!d.TEXT){replyError('No dictation captured',legacy);return;}
  if(d.VOLUME===0)enableTts=false;
  askViaBridge(d.TEXT,legacy);
});
