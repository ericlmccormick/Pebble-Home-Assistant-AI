// Run with: node tests/test_conversation.js
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const source=fs.readFileSync('src/pkjs/index.js','utf8');
const sent=[];
let opened=null;
function MockWebSocket(url) {
  this.url=url;this.readyState=1;this.bufferedAmount=0;this.sent=[];
  this.send=(payload)=>this.sent.push(payload);
  this.close=()=>{this.readyState=3;};
  opened=this;
}
const storage=new Map([['HA_URL','https://test.example'],['HA_TOKEN','test-token'],['ENABLE_TTS','false']]);
const localStorage={
  getItem:key=>storage.has(key)?storage.get(key):null,
  setItem:(key,value)=>storage.set(key,String(value)),
  removeItem:key=>storage.delete(key)
};
const Pebble={
  listeners:{},
  getActiveWatchInfo:()=>({platform:'emery'}),
  addEventListener:function(name,cb){this.listeners[name]=cb;},
  sendAppMessage:function(payload,success){sent.push(payload);if(success)success();},
  openURL:()=>{}
};
const context={console,require:(name)=>{
  assert.strictEqual(name,'pebble-clay');
  return function(){this.generateUrl=()=>'';};
},Pebble,localStorage,WebSocket:MockWebSocket,Uint8Array,DataView,
setTimeout:()=>1,clearTimeout:()=>{},Array,JSON,Math,String,Error,Date,
Promise,fetch:()=>Promise.reject(Error('not expected'))};
vm.createContext(context);
vm.runInContext(source,context);
context.conversationStart();
assert(opened);
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
// Queue compressed silence before the run-start handshake completes.
context.conversationAudioFrame(new Uint8Array(320),0);
context.conversationEnd=true;
context.conversationFlushAudio();
assert.strictEqual(opened.sent.length,2,'audio must wait for run-start handler ID');
msg({type:'event',id:command.id,event:{
  type:'run-start',data:{runner_data:{stt_binary_handler_id:7}}
}});
assert.strictEqual(opened.sent.length,5);
for(let i=2;i<4;i++){
  const frame=new Uint8Array(opened.sent[i]);
  assert.strictEqual(frame.length,641);
  assert.strictEqual(frame[0],7);
  assert.strictEqual(frame[1],0);
}
assert.deepStrictEqual(Array.from(new Uint8Array(opened.sent[4])),[7],
  'end of input must be a single handler byte');
const before=sent.length;
msg({type:'event',id:command.id,event:{
  type:'intent-end',data:{intent_output:{response:{
    conversation_id:'abc123',
    speech:{plain:{speech:'Kitchen lights are on.'}}
  }}}
}});
assert.strictEqual(storage.get('HA_CONVERSATION_ID'),'abc123');
assert(sent.length>before);
assert(sent.some(d=>d.COMMAND==='TEXT_RESPONSE_NO_AUDIO'&&
  d.TEXT==='Kitchen lights are on.'));
assert(sent.some(d=>d.COMMAND==='CONV_RESUME'));
console.log('Assist conversation protocol tests passed');
