// Release settings, HTTP retries and text-only behavior.
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const source=fs.readFileSync('src/pkjs/index.js','utf8');
const storage=new Map([
  ['HA_URL','https://ha.example'],['HA_TOKEN','access-token'],
  ['HA_AGENT','conversation.google_ai'],['HA_TTS','tts.home_assistant_cloud'],
  ['ENABLE_TTS','true'],['TEXT_ONLY','true']
]);
const sent=[], calls=[];
const Pebble={
  listeners:{},
  getActiveWatchInfo(){return {platform:'emery'};},
  addEventListener(name,cb){this.listeners[name]=cb;},
  openURL(){},
  sendAppMessage(payload,ok){sent.push(payload);if(ok)ok();}
};
const localStorage={
  getItem:k=>storage.has(k)?storage.get(k):null,
  setItem:(k,v)=>storage.set(k,String(v)),
  removeItem:k=>storage.delete(k)
};
const responses=[
  {ok:false,status:429},
  {ok:true,json:()=>Promise.resolve({response:{speech:{plain:{speech:'Living room lights are on.'}}},conversation_id:'conversation-1'})}
];
const context={
  console,require:n=>{assert.equal(n,'pebble-clay');return function(){this.generateUrl=()=>'';};},
  Pebble,localStorage,Promise,Array,JSON,Math,String,Error,Date,Uint8Array,DataView,
  fetch(url,opts){calls.push({url,opts});return Promise.resolve(responses.shift());},
  setTimeout(cb,ms){
    if(ms<5000)Promise.resolve().then(cb);
    return 1;
  },clearTimeout(){},
};
vm.createContext(context);
vm.runInContext(source,context);
function settings(obj) {
  const encoded=encodeURIComponent(JSON.stringify(obj));
  Pebble.listeners.webviewclosed({response:encoded});
}
(async()=>{
  Pebble.listeners.ready();
  assert(sent.some(p=>p.COMMAND==='SETTINGS'&&p.AUTO_SEND===1&&p.HAPTIC_LEVEL===2));
  // Migrate effective legacy preference: Text-only ON overrides old TTS ON.
  assert.equal(storage.get('ENABLE_TTS'),'false');
  assert.equal(storage.has('TEXT_ONLY'),false,'Legacy key should be removed');
  assert(source.includes("messageKey:'ENABLE_TTS'"));
  assert(!source.includes("messageKey:'TEXT_ONLY'"));
  settings({
    AUTO_SEND:{value:false},
    ENABLE_TTS:{value:false},
    HAPTIC_LEVEL:{value:'high'}
  });
  assert.equal(storage.get('AUTO_SEND'),'false');
  assert.equal(storage.get('ENABLE_TTS'),'false');
  assert.equal(storage.get('HAPTIC_LEVEL'),'high');
  assert(sent.some(p=>p.COMMAND==='SETTINGS'&&p.AUTO_SEND===0&&p.HAPTIC_LEVEL===3));
  assert(sent.some(p=>p.COMMAND==='HAPTIC_PREVIEW'&&p.HAPTIC_LEVEL===3));
  Pebble.listeners.appmessage({payload:{COMMAND:'DICTATION',TEXT:'Turn on living room lights',VOLUME:70}});
  for(let i=0;i<20;i++)await Promise.resolve();
  assert.equal(calls.length,2,'HTTP 429 may be retried once for a command');
  assert(calls.every(x=>x.url==='https://ha.example/api/conversation/process'));
  assert(sent.some(p=>p.COMMAND==='TEXT_RESPONSE_NO_AUDIO'&&p.TEXT==='Living room lights are on.'));
  assert(!sent.some(p=>p.COMMAND==='TEXT_RESPONSE_8_16'));
  assert.equal(storage.get('HA_CONVERSATION_ID'),'conversation-1');
  console.log('Release behavior checks passed');
})().catch(err=>{console.error(err);process.exitCode=1;});
