const assert=require('assert'),fs=require('fs'),vm=require('vm');
const code=fs.readFileSync('src/pkjs/index.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const plugin=JSON.parse(fs.readFileSync('home-assistant-plugin/package.json','utf8'));
const uuid=plugin.pebble.uuid;
// Connection selector must be the first settings section, ahead of built-in
// credentials, and retain a clear explanation of voice-mode limitations.
const firstSection=code.slice(code.indexOf("var clayConfig = ["),code.indexOf("function configField("));
assert(firstSection.indexOf("messageKey:'USE_HA_PLUGIN'") > -1);
assert(firstSection.indexOf("messageKey:'USE_HA_PLUGIN'") < firstSection.indexOf("messageKey:'HA_URL'"));
assert(firstSection.includes("label:'Use Home Assistant plugin'"));
assert(firstSection.includes('Continuous voice streaming and spoken TTS still require the built-in connection.'));

assert(pkg.pebble.usesPermissions.some(p=>p.plugin===uuid&&p.name==='HomeConverse'));
assert(pkg.pebble.usesPermissions.some(p=>p.plugin===uuid&&p.name==='InvokeAction'));
const sent=[],requests=[],store=new Map([['USE_HA_PLUGIN','true'],['ENABLE_TTS','false']]);
const Pebble={listeners:{},getActiveWatchInfo:()=>({platform:'emery'}),addEventListener(n,fn){this.listeners[n]=fn;},
  sendAppMessage(p,ok){sent.push(p);if(ok)ok();},openURL(){},
  invokeAction:async req=>{requests.push(req);return {ok:true,text:JSON.stringify({text:'Lights are off.',conversation_id:'new-id'})};}};
const context={console,require:n=>function(){this.generateUrl=()=>'';},Pebble,
  localStorage:{getItem:k=>store.has(k)?store.get(k):null,
    setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
  Uint8Array,ArrayBuffer,DataView,Date,Promise,JSON,Math,String,Error,Array,
  setTimeout:()=>1,clearTimeout:()=>{},fetch:()=>Promise.reject(Error('No direct network'))};
vm.createContext(context);vm.runInContext(code,context);
Pebble.listeners.appmessage({payload:{COMMAND:'DICTATION',TEXT:'Turn off the kitchen lights'}});
setImmediate(()=>{
  try {
    assert.strictEqual(requests.length,1);
    assert.strictEqual(requests[0].plugin,uuid);
    assert.strictEqual(requests[0].action,'conversation');
    assert.strictEqual(requests[0].args.text,'Turn off the kitchen lights');
    assert(sent.some(x=>x.COMMAND==='TEXT_RESPONSE_NO_AUDIO'&&x.TEXT==='Lights are off.'));
    assert.strictEqual(store.get('HA_CONVERSATION_ID'),'new-id');
    assert.strictEqual(store.get('HA_TOKEN'),undefined,'Plugin token must not be stored by watchapp');
    console.log('Plugin provider toggle and text conversation regression passed');
  } catch(e){console.error(e);process.exitCode=1;}
});
