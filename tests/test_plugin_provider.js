const assert=require('assert'),fs=require('fs'),vm=require('vm');
const code=fs.readFileSync('src/pkjs/index.js','utf8');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
// The standalone plugin now lives in ericlmccormick/Pebble-HA-plug-in.
// Keep the protocol UUID stable across repositories and releases.
const uuid='a74370b6-929c-4ec0-b7ee-2fc6fca8db57';
// Connection selector must be the first settings section, ahead of built-in
// credentials, and retain a clear explanation of voice-mode limitations.
const firstSection=code.slice(code.indexOf("var clayConfig = ["),code.indexOf("function configField("));
assert(firstSection.indexOf("messageKey:'USE_BUILTIN_CONNECTION'") > -1);
assert(firstSection.indexOf("messageKey:'USE_BUILTIN_CONNECTION'") < firstSection.indexOf("messageKey:'HA_URL'"));
assert(firstSection.includes("label:'Use built-in connection'"));
assert(firstSection.includes('plugin handles conversations and speech generation'));
assert(code.includes('function connectionModeClay()'));
assert(code.includes("toggle.on('change',updateVisibility)"));
assert(code.includes("['HA_URL','HA_TOKEN','HA_PIPELINE','HA_AGENT','HA_TTS']"));
assert(code.includes("var useHaPlugin = localStorage.getItem('USE_HA_PLUGIN') !== 'false'"));

assert(pkg.pebble.usesPermissions.some(p=>p.plugin===uuid&&p.name==='HomeConverse'));
assert(pkg.pebble.usesPermissions.some(p=>p.plugin===uuid&&p.name==='InvokeAction'));
const sent=[],requests=[],store=new Map([['ENABLE_TTS','false']]);
let customClay=null;
const MockClay=function(config,custom){customClay=custom;this.generateUrl=()=>'';};
const Pebble={listeners:{},getActiveWatchInfo:()=>({platform:'emery'}),addEventListener(n,fn){this.listeners[n]=fn;},
  sendAppMessage(p,ok){sent.push(p);if(ok)ok();},openURL(){},
  invokeAction:async req=>{requests.push(req);return {ok:true,text:JSON.stringify({text:'Lights are off.',conversation_id:'new-id'})};}};
const context={console,require:n=>MockClay,Pebble,
  localStorage:{getItem:k=>store.has(k)?store.get(k):null,
    setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
  Uint8Array,ArrayBuffer,DataView,Date,Promise,JSON,Math,String,Error,Array,
  setTimeout:()=>1,clearTimeout:()=>{},fetch:()=>Promise.reject(Error('No direct network'))};
vm.createContext(context);vm.runInContext(code,context);
// Exercise actual Clay show/hide callbacks rather than checking text alone.
assert.strictEqual(typeof customClay,'function');
const fieldNames=['HA_URL','HA_TOKEN','HA_PIPELINE','HA_AGENT','HA_TTS'];
const visibility={};
let enabled=false,onBuild=null,onToggle=null;
function item(key) {
  return {get:()=>enabled,
    on:(name,cb)=>{assert.strictEqual(name,'change');onToggle=cb;},
    show:()=>{visibility[key]=true;},
    hide:()=>{visibility[key]=false;}};
}
const items={};
fieldNames.forEach(k=>items[k]=item(k));
items.USE_BUILTIN_CONNECTION=item('USE_BUILTIN_CONNECTION');
items.builtin_connection_heading=item('builtin_connection_heading');
const clayPage={
  EVENTS:{AFTER_BUILD:'after_build'},
  on:(ev,cb)=>{assert.strictEqual(ev,'after_build');onBuild=cb;},
  getItemByMessageKey:key=>items[key],
  getItemById:key=>items[key]
};
customClay.call(clayPage);
assert(onBuild);
onBuild();
for(const key of fieldNames.concat('builtin_connection_heading'))
  assert.strictEqual(visibility[key],false,'Plugin default should hide '+key);
enabled=true;onToggle();
for(const key of fieldNames.concat('builtin_connection_heading'))
  assert.strictEqual(visibility[key],true,'Built-in toggle should show '+key);
enabled=false;onToggle();
for(const key of fieldNames.concat('builtin_connection_heading'))
  assert.strictEqual(visibility[key],false,'Switching back should hide '+key);
Pebble.listeners.appmessage({payload:{COMMAND:'DICTATION',TEXT:'Turn off the kitchen lights'}});
setImmediate(()=>{
  try {
    assert.strictEqual(requests.length,1);
    assert.strictEqual(requests[0].plugin,uuid);
    assert.strictEqual(requests[0].action,'conversation');
    assert.strictEqual(requests[0].args.text,'Turn off the kitchen lights');
    assert(sent.some(x=>x.COMMAND==='TEXT_RESPONSE_NO_AUDIO'&&x.TEXT==='Lights are off.'));
    assert(code.includes("pluginAction('tts_prepare',{text:sentence})"));
    assert(code.includes("pluginAction('tts_chunk',{session_id:session,offset:offset})"));
    assert(code.includes("startPluginTTSFetchLoop(generation)"));
    assert.strictEqual(store.get('HA_CONVERSATION_ID'),'new-id');
    assert.strictEqual(store.get('HA_TOKEN'),undefined,'Plugin token must not be stored by watchapp');
    Pebble.listeners.webviewclosed({response:encodeURIComponent(JSON.stringify({USE_BUILTIN_CONNECTION:{value:true}}))});
    assert.strictEqual(store.get('USE_HA_PLUGIN'),'false','Built-in mode should persist');
    console.log('Plugin provider toggle and text conversation regression passed');
  } catch(e){console.error(e);process.exitCode=1;}
});
