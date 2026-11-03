// node tests/test_settings_discovery.js
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const source=fs.readFileSync('src/pkjs/index.js','utf8');
const storage=new Map([
  ['HA_URL','https://example.test'],
  ['HA_TOKEN','test-token'],
  ['HA_AGENT','conversation.google_ai'],
  ['HA_TTS','tts.home_assistant_cloud']
]);
const snapshots=[],opened=[];
function Clay(config) {
  snapshots.push(JSON.parse(JSON.stringify(config)));
  this.generateUrl=()=> 'clay://config';
}
const Pebble={
  listeners:{},
  getActiveWatchInfo:()=>({platform:'emery'}),
  addEventListener(name,cb){this.listeners[name]=cb;},
  openURL(url){opened.push(url);},
  sendAppMessage(){}
};
function WebSocket(url) {
  this.url=url;
  this.send=raw=>{
    let msg=JSON.parse(raw);
    if(msg.type==='auth'){
      this.onmessage({data:JSON.stringify({type:'auth_ok'})});
    }else if(msg.type==='assist_pipeline/pipeline/list'){
      this.onmessage({data:JSON.stringify({
        id:msg.id,type:'result',success:true,result:{
          preferred_pipeline:'main',pipelines:[
            {id:'main',name:'Main Assist',stt_engine:'stt.home_assistant_cloud',
             conversation_engine:'conversation.google_ai'}
          ]
        }
      })});
    }
  };
  this.close=()=>{};
  Promise.resolve().then(()=>this.onmessage({data:JSON.stringify({type:'auth_required'})}));
}
const localStorage={
  getItem(key){return storage.has(key)?storage.get(key):null;},
  setItem(key,val){storage.set(key,String(val));},
  removeItem(key){storage.delete(key);}
};
const states=[
  {entity_id:'conversation.google_ai',attributes:{friendly_name:'Google AI'}},
  {entity_id:'conversation.home_assistant',attributes:{friendly_name:'Home Assistant'}},
  {entity_id:'tts.home_assistant_cloud',attributes:{friendly_name:'Cloud Voice'}},
  {entity_id:'tts.google_ai_tts',attributes:{friendly_name:'Google AI Voice'}},
  {entity_id:'light.kitchen',attributes:{friendly_name:'Kitchen'}}
];
let requests=0;
const context={
  require(name){assert.equal(name,'pebble-clay');return Clay;},
  localStorage,Pebble,WebSocket,Promise,Uint8Array,DataView,
  fetch(url,options){
    requests++;
    assert.equal(url,'https://example.test/api/states');
    assert.equal(options.headers.Authorization,'Bearer test-token');
    return Promise.resolve({ok:true,json:()=>Promise.resolve(states)});
  },
  setTimeout(){return 1;},clearTimeout(){},
  console,Array,JSON,Math,String,Error,Date
};
vm.createContext(context);vm.runInContext(source,context);
function get(config,key) {
  for(const section of config)for(const field of (section.items||[]))
    if(field.messageKey===key)return field;
  throw Error('missing '+key);
}
(async()=>{
  Pebble.listeners.showConfiguration();
  for(let i=0;i<12;i++)await Promise.resolve();
  assert.equal(requests,1);
  assert.equal(opened.length,1);
  const config=snapshots[snapshots.length-1];
  for(const k of ['HA_AGENT','HA_TTS','HA_PIPELINE'])
    assert.equal(get(config,k).type,'select',k);
  assert.equal(get(config,'HA_AGENT').defaultValue,'conversation.google_ai');
  assert.equal(get(config,'HA_TTS').defaultValue,'tts.home_assistant_cloud');
  assert(get(config,'HA_PIPELINE').options.some(v=>v.value==='main'&&v.label.includes('stt.home_assistant_cloud')));
  assert(get(config,'HA_AGENT').options.some(v=>v.label.includes('Google AI')));
  console.log('Settings discovery tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
