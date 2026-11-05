// Simulate PebbleOS SDK 110 native microphone event -> HA STT/intent -> watch.
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const source=fs.readFileSync('src/pkjs/index.js','utf8');
const sent=[];
let opened=null;
function MockWebSocket(url) {
  this.url=url;this.readyState=1;this.bufferedAmount=0;this.sent=[];
  this.send=payload=>this.sent.push(payload);
  this.close=()=>{this.readyState=3;};
  opened=this;
}
const storage=new Map([
  ['HA_URL','https://test.example'],['HA_TOKEN','test-token'],['ENABLE_TTS','false']
]);
const Pebble={
  listeners:{},
  getActiveWatchInfo:()=>({platform:'emery'}),
  addEventListener:function(name,cb){this.listeners[name]=cb;},
  sendAppMessage:function(payload,success){sent.push(payload);if(success)success();},
  openURL:()=>{}
};
const context={console,require:name=>{
  assert.strictEqual(name,'pebble-clay');
  return function(){this.generateUrl=()=>'';};
},Pebble,localStorage:{
  getItem:key=>storage.has(key)?storage.get(key):null,
  setItem:(key,value)=>storage.set(key,String(value)),
  removeItem:key=>storage.delete(key)
},WebSocket:MockWebSocket,Uint8Array,ArrayBuffer,DataView,
setTimeout:()=>1,clearTimeout:()=>{},Array,JSON,Math,String,Error,Date,Promise,
fetch:()=>Promise.reject(Error('Unexpected HTTP call'))};
vm.createContext(context);
vm.runInContext(source,context);
function event(name,data){assert(Pebble.listeners[name],name);Pebble.listeners[name](data||{});}
function pcm(amplitude) {
  const p=new Uint8Array(640);
  for(let i=0;i<320;i++){
    const value=i%2?amplitude:-amplitude;
    p[i*2]=value&255;p[i*2+1]=(value>>8)&255;
  }
  return p.buffer;
}
event('appmessage',{payload:{COMMAND:'MIC_MODE_ON'}});
event('audiostreamstart',{sampleRate:16000,format:'pcm16le'});
// Idle silence must NOT terminate a continuous listening session.
for(let i=0;i<1200;i++)event('audiostream',{data:pcm(0)});
assert(!sent.some(p=>p.COMMAND==='MIC_TURN_END'),
  'quiet room must not stop continuous listening');
for(let i=0;i<5;i++)event('audiostream',{data:pcm(1000)});
assert(opened,'speech should start HA WebSocket');
assert.strictEqual(opened.url,'wss://test.example/api/websocket');
function msg(object){opened.onmessage({data:JSON.stringify(object)});}
msg({type:'auth_required'});
assert.deepStrictEqual(JSON.parse(opened.sent[0]),{type:'auth',access_token:'test-token'});
msg({type:'auth_ok'});
const command=JSON.parse(opened.sent[1]);
assert.strictEqual(command.type,'assist_pipeline/run');
assert.strictEqual(command.start_stage,'stt');
assert.strictEqual(command.end_stage,'intent');
assert.strictEqual(command.input.sample_rate,16000);
msg({type:'event',id:command.id,event:{
  type:'run-start',data:{runner_data:{stt_binary_handler_id:7}}
}});

// Regression: 24 seconds of idle listening before speech must NOT consume
// the spoken-turn recording budget and immediately cut the speaker off.
for(let i=0;i<240;i++)event('audiostream',{data:pcm(0)});
assert(!sent.some(p=>p.COMMAND==='MIC_TURN_END'),
  'a 4.8 second thinking pause must not end the utterance');
for(let i=0;i<200;i++)event('audiostream',{data:pcm(1000)});
assert(!sent.some(p=>p.COMMAND==='MIC_TURN_END'),
  'longer than three seconds of speaking must remain uninterrupted');
for(let i=0;i<200;i++)event('audiostream',{data:pcm(0)});
assert(!sent.some(p=>p.COMMAND==='MIC_TURN_END'),
  'a second 4 second pause must not end the utterance');
for(let i=0;i<10;i++)event('audiostream',{data:pcm(1000)});
assert(!sent.some(p=>p.COMMAND==='MIC_TURN_END'),
  'resuming speech must reset the end-of-speech silence timer');
assert(opened.sent.length>2,'native audio forwarded');
const packet=new Uint8Array(opened.sent[2]);
assert.equal(packet[0],7);
assert.equal(packet.length,641);
for(let i=0;i<240;i++)event('audiostream',{data:pcm(0)});
assert(!sent.some(p=>p.COMMAND==='MIC_TURN_END'),
  '4.8 seconds of silence should not end the utterance');
for(let i=0;i<10;i++)event('audiostream',{data:pcm(0)});
assert(sent.some(p=>p.COMMAND==='MIC_TURN_END'),
  '5 seconds of trailing silence should end the utterance');
event('audiostreamstop',{});
assert.deepStrictEqual(Array.from(new Uint8Array(opened.sent[opened.sent.length-1])),[7],
  'end of PCM is single handler byte');
msg({type:'event',id:command.id,event:{
  type:'stt-end',data:{stt_output:{text:'Are the doors locked?'}}
}});
assert(sent.some(p=>p.COMMAND==='CONV_TRANSCRIPT'&&p.TEXT==='Are the doors locked?'));
msg({type:'event',id:command.id,event:{
  type:'intent-end',data:{intent_output:{response:{
    conversation_id:'abc123',
    speech:{plain:{speech:'All exterior doors are locked.'}}
  }}}
}});
assert.strictEqual(storage.get('HA_CONVERSATION_ID'),'abc123');
assert(sent.some(p=>p.COMMAND==='TEXT_RESPONSE_NO_AUDIO'&&
  p.TEXT==='All exterior doors are locked.'));
assert(sent.some(p=>p.COMMAND==='CONV_RESUME'));
event('appmessage',{payload:{COMMAND:'MIC_MODE_OFF'}});
assert(!context.nativeMicMode);
console.log('Native audio streaming and Assist conversation regression passed');
