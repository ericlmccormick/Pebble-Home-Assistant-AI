// Home Assistant Bridge for Pebble plugins (preview API).
// Credentials never leave secureStorage and never appear in source/action results.
var URL_KEY='ha_bridge_url';
var TOKEN_KEY='ha_bridge_token';
var SOURCES=['home_assistant/entity','home_assistant/configured'];
function baseUrl() { return (localStorage.getItem(URL_KEY)||'').replace(/\/+$/,''); }
function validBase(value) {
  var s=String(value||'').trim().replace(/\/+$/,'');
  if(!/^https:\/\/[^\s/?#@]+(?::[0-9]{1,5})?$/i.test(s)) throw Error('Use an HTTPS server URL with no path, credentials or query.');
  return s;
}
function safeId(value) {return /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(String(value||''));}
function safePart(value) {return /^[a-z][a-z0-9_]*$/.test(String(value||''));}
function failure(code,message){return {ok:false,code:code,message:message};}
async function api(path,method,body) {
  var url=baseUrl(),token=await Pebble.secureStorage.getItem(TOKEN_KEY);
  if(!url||!token)return failure('AUTH_REQUIRED','Configure the Home Assistant plugin.');
  try {
    var res=await fetch(url+path,{
      method:method||'GET',
      headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
      body:typeof body==='undefined'?undefined:JSON.stringify(body)
    });
    if(!res.ok)return failure(res.status===401||res.status===403?'AUTH_REQUIRED':'PLUGIN_UNAVAILABLE',
      'Home Assistant HTTP '+res.status);
    var contentType=res.headers&&res.headers.get&&res.headers.get('content-type')||'';
    var data=contentType.indexOf('json')>=0?await res.json():await res.text();
    return {ok:true,data:data};
  }catch(e){
    // Never log the URL or token: they may contain private hostnames.
    return failure('PLUGIN_UNAVAILABLE','Home Assistant connection failed; check network permission and HTTPS.');
  }
}
function compact(state){
  var a=state.attributes||{};
  return {entity_id:state.entity_id,state:state.state,
    friendly_name:String(a.friendly_name||state.entity_id),
    unit:String(a.unit_of_measurement||''),
    attributes:a,last_changed:state.last_changed};
}
function sourceProperties(state) {
  var a=state.attributes||{},text=String(state.state||'unknown');
  var prop={name:{shortText:{text:String(a.friendly_name||state.entity_id).slice(0,120)}},
    entity_id:{shortText:{text:state.entity_id}},
    domain:{shortText:{text:state.entity_id.split('.')[0]}},
    state:{shortText:{text:text.slice(0,90)},longText:{text:text.slice(0,500)}}};
  var n=Number(text);
  if(text.trim()&&isFinite(n)) {
    prop.value={numericValue:{value:n,unit:String(a.unit_of_measurement||'').slice(0,24)}};
  }
  if(text==='on'||text==='off')prop.on={boolean:{value:text==='on'}};
  if(a.unit_of_measurement)prop.unit={shortText:{text:String(a.unit_of_measurement).slice(0,32)}};
  return prop;
}
Pebble.registerSourceHandler(async function(request,respond){
  if(request.item==='configured'){
    var present=!!baseUrl()&&!!(await Pebble.secureStorage.getItem(TOKEN_KEY));
    respond.data({validUntilMs:Date.now()+120000,instances:[{
      instanceId:'home',properties:{name:{shortText:{text:'Home Assistant'}},
        configured:{boolean:{value:present}}}}]});return;
  }
  if(request.item!=='entity'){respond.error('INVALID_REQUEST','Unknown source');return;}
  var result=await api('/api/states');
  if(!result.ok){respond.error(result.code,result.message);return;}
  if(!Array.isArray(result.data)){respond.error('UNKNOWN','Unexpected states response');return;}
  respond.data({validUntilMs:Date.now()+30000,instances:result.data.slice(0,400).map(function(state){
    return {instanceId:state.entity_id,properties:sourceProperties(state)};
  })});
});
var SAFE_READ=/^\/api\/(?:config|services|states(?:\/[a-z][a-z0-9_]*\.[a-z0-9_]+)?|calendars|history\/period(?:\/[0-9TZ:+.-]+)?|logbook(?:\/[0-9TZ:+.-]+)?)(?:\?[a-zA-Z0-9_=&%.,:+-]+)?$/;
Pebble.registerActionHandler(async function(request,respond) {
  var args=request.args||{},r,refresh=[];
  switch(request.action){
    case 'get_state':
      if(!safeId(args.entity_id)){respond.error('INVALID_ARGS','Invalid entity_id');return;}
      r=await api('/api/states/'+encodeURIComponent(args.entity_id));break;
    case 'list_states':
      r=await api('/api/states');
      if(r.ok&&Array.isArray(r.data)){
        var domain=args.domain;
        if(domain&&!safePart(domain)){respond.error('INVALID_ARGS','Invalid domain');return;}
        var states=r.data.filter(function(x){return !domain||x.entity_id.indexOf(domain+'.')===0;});
        r.data=states.slice(0,Math.min(100,Math.max(1,Number(args.limit)||50))).map(compact);
      }
      break;
    case 'read_api':
      if(typeof args.path!=='string'||!SAFE_READ.test(args.path)){
        respond.error('INVALID_ARGS','API path not on read-only allowlist');return;
      }
      r=await api(args.path);break;
    case 'conversation':
      if(typeof args.text!=='string'||!args.text.trim()||args.text.length>4000){
        respond.error('INVALID_ARGS','Message must contain 1–4000 characters');return;
      }
      var body={text:args.text,language:'en'};
      if(args.agent_id)body.agent_id=String(args.agent_id);
      if(args.conversation_id)body.conversation_id=String(args.conversation_id);
      r=await api('/api/conversation/process','POST',body);
      if(r.ok){
        var d=r.data||{},speech=d.response&&d.response.speech&&d.response.speech.plain;
        r.data={text:String(speech&&speech.speech||''),conversation_id:d.conversation_id||'',
          response_type:d.response&&d.response.response_type||''};
      }
      break;
    case 'render_template':
      if(typeof args.template!=='string'||args.template.length>4000){
        respond.error('INVALID_ARGS','Template too long');return;
      }
      r=await api('/api/template','POST',{template:args.template});break;
    case 'call_service':
      if(!safePart(args.domain)||!safePart(args.service)){
        respond.error('INVALID_ARGS','Invalid service');return;
      }
      var payload=Object.assign({},args.data||{});
      if(args.target)payload.target=args.target;
      r=await api('/api/services/'+args.domain+'/'+args.service,'POST',payload);
      refresh=['home_assistant/entity'];break;
    case 'fire_event':
      if(!safePart(args.event_type)){respond.error('INVALID_ARGS','Invalid event type');return;}
      r=await api('/api/events/'+args.event_type,'POST',args.event_data||{});break;
    default:respond.error('INVALID_REQUEST','Unknown action');return;
  }
  if(!r.ok){respond.error(r.code,r.message);return;}
  // Structured JSON replies are carried in result data; never include credentials.
  respond.ok({text:typeof r.data==='string'?r.data.slice(0,2000):
    JSON.stringify(r.data).slice(0,20000),refreshed:refresh});
  if(refresh.length)Pebble.refreshSources(refresh);
});
Pebble.registerConfigHandler(async function(message,respond){
  switch(message&&message.type){
    case 'status':{
      var hasToken=!!(await Pebble.secureStorage.getItem(TOKEN_KEY));
      respond({url:baseUrl(),hasToken:hasToken,configured:!!baseUrl()&&hasToken});return;
    }
    case 'save':{
      try{
        var url=validBase(message.url);
        if(typeof message.token==='string'&&message.token.trim()){
          await Pebble.secureStorage.setItem(TOKEN_KEY,message.token.trim());
        } else if(!(await Pebble.secureStorage.getItem(TOKEN_KEY))){
          respond({ok:false,error:'Enter a Home Assistant token.'});return;
        }
        localStorage.setItem(URL_KEY,url);
        Pebble.refreshSources(SOURCES);
        respond({ok:true,url:url});return;
      }catch(e){respond({ok:false,error:e.message});return;}
    }
    case 'test':{
      var result=await api('/api/config');
      respond(result.ok?{ok:true,name:result.data&&result.data.location_name||'Home Assistant'}:
        {ok:false,error:result.message});return;
    }
    case 'forget':
      await Pebble.secureStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(URL_KEY);
      Pebble.refreshSources(SOURCES);
      respond({ok:true});return;
    default:respond({ok:false,error:'Unknown configuration request'});
  }
});
