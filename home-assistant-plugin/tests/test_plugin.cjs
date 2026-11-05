const assert=require('assert');
const fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).pebble;
assert.strictEqual(pkg.projectType,'plugin');
assert.strictEqual(pkg.manifestVersion,2);
assert(pkg.plugin.actions.find(a=>a.name==='call_service').callerPermissions.includes('HomeControl'));
assert(pkg.plugin.actions.find(a=>a.name==='conversation').callerPermissions.includes('HomeConverse'));
assert(pkg.plugin.sources.find(s=>s.items.includes('entity')).callerPermissions.includes('HomeRead'));
let config,source,action,stored={},local={},calls=[];
const secure={
  getItem:async k=>stored[k]||null,
  setItem:async(k,v)=>{stored[k]=v;},
  removeItem:async k=>{delete stored[k];}
};
const Pebble={secureStorage:secure,refreshSources:()=>{},
  registerConfigHandler:fn=>config=fn,
  registerSourceHandler:fn=>source=fn,
  registerActionHandler:fn=>action=fn};
const context={Pebble,console,Date,JSON,Number,String,Object,Array,Promise,isFinite,
  localStorage:{getItem:k=>local[k]||null,setItem:(k,v)=>local[k]=v,removeItem:k=>delete local[k]},
  fetch:async(url,opt)=>{
    calls.push({url,opt});
    const path=new URL(url).pathname;
    let data=path==='/api/config'?{location_name:'Test Home'}:
      path==='/api/states'?[{entity_id:'sensor.temp',state:'21.5',attributes:{friendly_name:'Temperature',unit_of_measurement:'°C'}},
        {entity_id:'light.kitchen',state:'on',attributes:{friendly_name:'Kitchen'}}]:
      path==='/api/conversation/process'?{conversation_id:'abc',response:{speech:{plain:{speech:'Lights are on.'}}}}:
      {entity_id:'light.kitchen',state:'on',attributes:{}};
    return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data,text:async()=>JSON.stringify(data)};
  },
  URL
};
vm.runInNewContext(fs.readFileSync(path.join(root,pkg.plugin.script),'utf8'),context);
function callConfig(m){return new Promise(resolve=>config(m,resolve));}
function callAction(name,args){return new Promise(resolve=>action({action:name,args:args||{}},{
  ok:x=>resolve({ok:true,...x}),error:(code,message)=>resolve({ok:false,code,message})}));}
function callSource(item){return new Promise(resolve=>source({item},{data:d=>resolve(d),error:(code,message)=>resolve({code,message})}));}
(async()=>{
  let s=await callConfig({type:'save',url:'https://ha.example.com',token:'secret'});
  assert.strictEqual(s.ok,true);
  assert.strictEqual(stored.ha_bridge_token,'secret');
  assert(!JSON.stringify(await callConfig({type:'status'})).includes('secret'));
  s=await callConfig({type:'test'});assert.strictEqual(s.name,'Test Home');
  let data=await callSource('entity');
  assert.strictEqual(data.instances.length,2);
  assert.strictEqual(data.instances[0].properties.value.numericValue.value,21.5);
  let r=await callAction('conversation',{text:'Hello'});
  assert(r.ok);assert(JSON.parse(r.text).text==='Lights are on.');
  r=await callAction('call_service',{domain:'light',service:'turn_on',data:{entity_id:'light.kitchen'}});
  assert(r.ok);
  r=await callAction('read_api',{path:'/api/auth'});
  assert.strictEqual(r.code,'INVALID_ARGS');
  r=await callAction('call_service',{domain:'../auth',service:'x'});
  assert.strictEqual(r.code,'INVALID_ARGS');
  assert(calls.every(c=>c.opt.headers.Authorization==='Bearer secret'));
  assert(calls.some(c=>c.url.endsWith('/api/')&&!c.opt.headers['Content-Type']),
    'GET connection test must not send Content-Type');
  assert(calls.every(c=>c.opt.body || !c.opt.headers['Content-Type']),
    'Only requests with JSON bodies should declare Content-Type');
  s=await callConfig({type:'forget'});assert(s.ok);
  assert(!stored.ha_bridge_token);
  console.log('Home Assistant plugin API and credential isolation checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
