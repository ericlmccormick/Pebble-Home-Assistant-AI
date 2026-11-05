const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const sent=[],requests=[],timers=[];
const store=new Map([
 ['HA_URL','https://example.test'],['HA_TOKEN','secret'],['HA_AGENT','conversation.google'],
 ['TEXT_ONLY','true'],['HA_CONVERSATION_ID',''],['USE_HA_PLUGIN','false']
]);
const Pebble={listeners:{},getActiveWatchInfo:()=>({platform:'emery'}),
 addEventListener:function(name,callback){this.listeners[name]=callback;},
 sendAppMessage:(payload,done)=>{sent.push(payload);if(done)done();},
 openURL:()=>{}};
const context={Pebble,console,Uint8Array,ArrayBuffer,DataView,Promise,Math,JSON,
 String,Error,Date,Array,
 require:(name)=>{assert.strictEqual(name,'pebble-clay');return function(){this.generateUrl=()=>'';};},
 localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,String(v)),
 removeItem:k=>store.delete(k)},
 setTimeout:(callback,delay)=>{timers.push(callback);return timers.length;},clearTimeout:()=>{},
 fetch:(url,options)=>{
  assert.strictEqual(url,'https://example.test/api/conversation/process');
  const body=JSON.parse(options.body);requests.push(body);
  return Promise.resolve({ok:true,json:()=>Promise.resolve({
    conversation_id:'conversation-123',response:{speech:{plain:{speech:'Yes, the doors are locked.'}}}
  })});
 }};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/pkjs/index.js','utf8'),context);
async function run(){
 Pebble.listeners.appmessage({payload:{COMMAND:'CONV_DICTATION',TEXT:'Are the doors locked?',VOLUME:100}});
 for(let n=0;n<8;n++)await Promise.resolve();
 assert.strictEqual(requests.length,1);
 assert.strictEqual(requests[0].text,'Are the doors locked?');
 assert.strictEqual(requests[0].agent_id,'conversation.google');
 assert(sent.some(x=>x.COMMAND==='TEXT_RESPONSE_NO_AUDIO'&&x.TEXT==='Yes, the doors are locked.'));
 assert(sent.some(x=>x.COMMAND==='CONV_RESUME'),'legacy mode must resume listening');
 assert.strictEqual(store.get('HA_CONVERSATION_ID'),'conversation-123');
 sent.length=0;
 Pebble.listeners.appmessage({payload:{COMMAND:'CONV_DICTATION',TEXT:'What about the garage?',VOLUME:100}});
 for(let n=0;n<8;n++)await Promise.resolve();
 assert.strictEqual(requests[1].conversation_id,'conversation-123');
 assert(sent.some(x=>x.COMMAND==='CONV_RESUME'));
 console.log('Legacy SDK conversation / no-audio resume regression passed');
}
run().catch(err=>{console.error(err);process.exitCode=1;});
