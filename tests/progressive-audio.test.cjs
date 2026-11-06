/* Reusable Home Assistant audio SDK integration smoke tests.
 * Run with: node tests/test_audio_sdk.cjs
 */
const assert=require('assert'),path=require('path');
const sdk=require('../src/pkjs/ha_audio.js');
const hash=bytes=>{
  let h=2166136261>>>0;
  for(const b of bytes)h=Math.imul((h^b)>>>0,16777619)>>>0;
  return h;
};
function wav(sampleCount){
  const b=Buffer.alloc(44+sampleCount*2);
  b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);
  b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);
  b.write('data',36);b.writeUInt32LE(sampleCount*2,40);
  for(let i=0;i<sampleCount;i++)
    b.writeInt16LE(Math.round(9500*Math.sin(2*Math.PI*440*i/8000)),44+i*2);
  return b;
}
const audio=wav(16000);
function fixture(corrupt){
  const storage={},calls=[],packets=[];
  let complete=0,errors=[],current=0;
  const store={getItem:k=>storage[k]||null,setItem:(k,v)=>{storage[k]=v}};
  const watch={
    sendAppMessage:(message,success)=>{
      packets.push(message);if(success)success();
    },
    invokeAction:({plugin,action,args})=>{
      assert.strictEqual(plugin,'a74370b6-929c-4ec0-b7ee-2fc6fca8db57');
      calls.push({action,args});
      if(action==='tts_prepare'){
        current++;
        const first=audio.subarray(0,6000);
        return Promise.resolve({ok:true,text:JSON.stringify({
          format:'pcm_s16le_wav',sample_rate:8000,channels:1,
          bits_per_sample:16,length:audio.length,sample_count:16000,
          session_id:'tts'+current,chunk_bytes:6000,
          wav_checksum:hash(audio),first_chunk:first.toString('base64'),
          first_chunk_checksum:hash(first),audio_diagnostics:{source:'home_assistant'}
        })});
      }
      if(action==='tts_chunk'){
        const b=audio.subarray(args.offset,Math.min(audio.length,args.offset+6000));
        const checksum=hash(b)^(corrupt&&args.offset===6000?1:0);
        return Promise.resolve({ok:true,text:JSON.stringify({
          offset:args.offset,audio:b.toString('base64'),checksum
        })});
      }
      if(action==='tts_release')return Promise.resolve({ok:true,text:'{}'});
      throw Error('Unexpected Bridge action '+action);
    }
  };
  const client=sdk.create({Pebble:watch,storage:store,
    onComplete:()=>complete++,onError:e=>errors.push(e.message)});
  return {client,packets,calls,errors,get complete(){return complete}};
}
function until(predicate,timeout=2500){
  return new Promise((resolve,reject)=>{
    const start=Date.now();
    (function poll(){
      if(predicate()){resolve();return;}
      if(Date.now()-start>timeout){reject(Error('Timed out waiting for transfer'));return;}
      setTimeout(poll,10);
    })();
  });
}
(async()=>{
  let f=fixture(false);
  await f.client.speak('Testing an integrated speech SDK.');
  await until(()=>f.complete===1);
  const cmds=f.packets.map(p=>p.COMMAND);
  assert.strictEqual(cmds[0],'AUDIO_RESET');
  assert.strictEqual(cmds.filter(c=>c==='AUDIO_SENTENCE_END').length,1);
  assert.strictEqual(f.packets.filter(p=>p.COMMAND==='AUDIO_CHUNK')
    .reduce((n,p)=>n+p.CHUNK.length,0),8000);
  assert(f.calls.some(c=>c.action==='tts_release'));
  assert.strictEqual(f.errors.length,0);
  assert.strictEqual(f.client.diagnostics().progressive_playback,true);
  let stats=null;
  const seen=f.client.handleMessage({COMMAND:'AUDIO_STATS',
    TEXT:'empty=2,empty_ms=40,partial=1,zero=0,peak=3500,frames=10'});
  assert.strictEqual(seen,true);
  assert.strictEqual(f.client.handleMessage({COMMAND:'OTHER'}),false);
  assert.strictEqual(f.client.diagnostics().transfer,'all streamed WAV chunks verified');
  let bad=fixture(true);
  await bad.client.speak('Bad chunk test.');
  await until(()=>bad.errors.length>0);
  assert(bad.errors[0].includes('chunk checksum mismatch'));
  assert(bad.packets.some(p=>p.COMMAND==='AUDIO_STOP'));
  assert.strictEqual(bad.complete,0);
  let long=fixture(false);
  await long.client.speak('longresponse '.repeat(90));
  await until(()=>long.complete===1,5000);
  const prepares=long.calls.filter(c=>c.action==='tts_prepare');
  assert(prepares.length>=2,'Long unpunctuated speech must be split');
  assert(prepares.every(c=>c.args.text.length<=500),
    'Every Bridge TTS request must obey the 500-character limit');
  let restart=fixture(false);
  await restart.client.speak('Cancel now.');
  restart.client.stop();
  assert(restart.packets.some(p=>p.COMMAND==='AUDIO_STOP'));
  console.log('Portable HA audio SDK: progressive playback, integrity, reset, telemetry, cancel PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
