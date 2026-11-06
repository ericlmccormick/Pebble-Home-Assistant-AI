const assert=require('assert');
const fs=require('fs'),vm=require('vm'),path=require('path');
const src=fs.readFileSync(path.join(__dirname,'../src/pkjs/index.js'),'utf8');
const begin=src.indexOf('var MAX_PENDING_STREAM_SEGMENTS=8;');
const end=src.indexOf('function startPluginTTSFetchLoop(gen)',begin);
assert(begin>=0&&end>begin,'Progressive WAV decoder missing');
const code=src.slice(begin,end);
const makeWav=(samples)=>{
  const bytes=Buffer.alloc(44+samples.length*2);
  bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);
  bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);
  bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);
  bytes.write('data',36);bytes.writeUInt32LE(samples.length*2,40);
  for(let i=0;i<samples.length;i++)bytes.writeInt16LE(samples[i],44+i*2);
  return bytes;
};
const hash=bytes=>{
  let h=2166136261>>>0;
  for(const b of bytes)h=Math.imul((h^b)>>>0,16777619)>>>0;
  return h;
};
const samples=Array.from({length:32000},(_,i)=>
  Math.round(9000*Math.sin(2*Math.PI*430*i/8000)));
const wav=makeWav(samples);
function newHarness(corrupt){
  const chunks=[];
  for(let i=0;i<wav.length;i+=6000)
    chunks.push({offset:i,bytes:wav.subarray(i,Math.min(wav.length,i+6000))});
  let actions=[],releases=0,values={},segments=[],observations=[];
  const ctx={
    Promise,Number,String,Math,Date,Uint8Array,
    requestGeneration:1,readyAudioQueue:[],
    PCM_DEBUG_STORAGE_KEY:'debug',
    setTimeout,
    localStorage:{
      getItem:k=>values[k]||null,setItem:(k,v)=>values[k]=String(v)
    },
    pluginResult:(r)=>r.data,
    pluginDecodeBase64:b64=>Array.from(Buffer.from(b64,'base64')),
    pluginWavChecksum:hash,
    encodeADPCM:pcm=>pcm.slice(), // Inspect the exact PCM samples and filter state.
    pluginAction:(name,args)=>{
      actions.push(name+(args.offset===undefined?'':':'+args.offset));
      if(name==='tts_release'){releases++;return Promise.resolve({data:{ok:true}});}
      if(name==='tts_prepare')return Promise.resolve({data:{
        session_id:'ttsabc',format:'pcm_s16le_wav',
        sample_rate:8000,channels:1,bits_per_sample:16,
        length:wav.length,sample_count:samples.length,chunk_bytes:6000,
        wav_checksum:hash(wav),
        first_chunk:chunks[0].bytes.toString('base64'),
        first_chunk_checksum:hash(chunks[0].bytes),
        audio_diagnostics:{source:'home_assistant'}
      }});
      const part=chunks.find(p=>p.offset===args.offset);
      if(!part)return Promise.reject(Error('Unknown WAV offset'));
      // Chunk completions can be out of order but playback must not be.
      const payload={
        offset:part.offset,checksum:hash(part.bytes),
        audio:part.bytes.toString('base64')
      };
      if(corrupt===part.offset)payload.checksum^=1;
      return new Promise(resolve=>setTimeout(()=>resolve({data:payload}),
        args.offset===6000?10:0));
    }
  };
  const exported=vm.runInNewContext(code+'\n({pluginStreamWav})',ctx);
  function onPcm(pcm,last){
    if(!segments.length)
      observations.push({firstBeforeRest:!actions.some(x=>x.startsWith('tts_chunk'))});
    segments.push({pcm:Array.from(pcm),last});
  }
  return {run:()=>exported.pluginStreamWav('Test sentence',1,onPcm),
    segments,actions,observations,get releases(){return releases;},
    get debug(){return JSON.parse(values.debug||'{}');}};
}
(async()=>{
  const h=newHarness(-1);
  await h.run();
  assert(h.observations[0].firstBeforeRest,
    'First verified audio must reach sender before requesting the rest of WAV');
  assert(h.segments.length>5,'Long WAV should yield multiple playback segments');
  assert.strictEqual(h.segments.filter(x=>x.last).length,1,
    'Only the last WAV chunk may end the sentence');
  assert(h.segments[h.segments.length-1].last,
    'Final sentence marker must follow final verified chunk');
  const pcm=h.segments.flatMap(x=>x.pcm);
  assert.strictEqual(pcm.length,samples.length,'Do not drop any PCM samples');
  const expected=samples.map((sample,i)=>i<2?sample:
    (sample+samples[i-1]+samples[i-2])/3);
  for(const i of [0,1,2,2977,2978,2979,5977,5978,15000,31999])
    assert(Math.abs(pcm[i]-expected[i])<1e-7,
      'PCM filter continuity lost across chunk boundary at '+i);
  assert.strictEqual(h.releases,1,'Release completed WAV session');
  assert(h.debug.first_audio_queued_ms>=0);
  assert.strictEqual(h.debug.transfer,'all streamed WAV chunks verified');
  assert.strictEqual(h.debug.progressive_playback,true);
  const broken=newHarness(6000);
  await assert.rejects(()=>broken.run(),/chunk checksum mismatch/);
  assert.strictEqual(broken.segments.length,1,
    'Corrupt later chunk should stop before sending its samples');
  assert.strictEqual(broken.releases,1,'Release aborted WAV session');
  console.log('Progressive WAV, out-of-order transfer, filtering, checksum and finalization tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
