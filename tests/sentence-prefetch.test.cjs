const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'../src/pkjs/index.js'),'utf8');
const helpers=src.slice(src.indexOf('var pluginPreparedSentence=null;'),
  src.indexOf('var isFetchingTTS = false'));
const producer=src.slice(src.indexOf('function startPluginTTSFetchLoop(gen)'),
  src.indexOf('function startTTSFetchLoop(gen)'));
assert(helpers.includes("pluginAction('tts_prepare',{text:sentence})"));
assert(producer.includes('prefetchNextBridgeSentence(gen);'));
assert(producer.includes('},selected.prepared)'));
const events=[],inflight=[],audio=[],messages=[];
const c={Promise,Error,requestGeneration:1,pluginPreparedSentence:null,
  sentenceQueue:['first','second','third'],readyAudioQueue:[],
  isFetchingTTS:false,isSendingBLE:true,
  MAX_READY_AUDIO_SENTENCES:2,conversationAudioFinalPending:false,
  legacyConversationTurn:false,lastAnswer:'hello',
  pluginAction:(action,args)=>{
    assert.strictEqual(action,'tts_prepare');
    events.push('prepare:'+args.text);
    return Promise.resolve({ok:true,text:args.text});
  },
  pluginStreamWav:(text,gen,onPcm,prepared)=>{
    events.push('stream:'+text);
    let resolve,first;
    const done=new Promise(r=>resolve=r);
    // Emulate pluginStreamWav: process first chunk after the (possibly
    // prefetched) metadata resolves, but keep the current transfer in flight.
    Promise.resolve(prepared||c.pluginAction('tts_prepare',{text})).then(()=>{
      events.push('first-audio:'+text);
      // Three chunks reach ~750ms of speech before background synthesis
      // competes with the active transport. Do not prefetch after the first.
      for(let n=0;n<3;n++){
        onPcm(Array(1000).fill(1),false);
        c.readyAudioQueue.shift(); // BLE consumer drains its queue
        if(n<2)assert(!events.includes('prepare:second') || text!=='first',
          'Next sentence must not start during critical initial chunks');
      }
      first=true;
    });
    inflight.push({text,resolve});
    return done;
  },
  startBLESendLoop:()=>{},conversationMaybeCompleteAudio:()=>{},
  console:{log:()=>{}},Pebble:{sendAppMessage:o=>messages.push(o)}
};
Object.assign(c,vm.runInNewContext(helpers+'\n({prefetchNextBridgeSentence,consumePreparedBridgeSentence})',c));
const start=vm.runInNewContext(producer+'\nstartPluginTTSFetchLoop',c);
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
  start(1);await tick();
  assert(events.includes('prepare:second'),'Prepare second while first is transferring');
  assert(!events.includes('stream:second'),'Second must not encode before first completes');
  assert.strictEqual(inflight.length,1);
  inflight[0].resolve();await tick();
  assert(events.includes('stream:second'),'Consume already prepared second sentence');
  assert(!events.filter(x=>x==='prepare:second').slice(1).length,
    'Do not synthesize the same sentence twice');
  assert(events.includes('prepare:third'),'Prefetch third while second transfers');
  assert(!events.includes('stream:third'));
  inflight[1].resolve();await tick();
  assert(events.includes('stream:third'));
  inflight[2].resolve();await tick();
  assert.strictEqual(c.sentenceQueue.length,0);
  assert.strictEqual(c.pluginPreparedSentence,null);
  assert.deepStrictEqual(events.filter(x=>x.startsWith('stream:')),
    ['stream:first','stream:second','stream:third']);
  console.log('Bridge next-sentence prefetch and serial playback regression passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
