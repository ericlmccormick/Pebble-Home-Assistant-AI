// Run with: node tests/test_wav_parser.js
const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const source=fs.readFileSync('src/pkjs/index.js','utf8');
const start=source.indexOf('function wavToPcm(bytes) {');
const end=source.indexOf('function fetchWav(path,gen,attempt) {',start);
assert(start>=0 && end>start,'WAV decoder source not found');
const sandbox={DataView,Uint8Array,String,Error,Array,Math};
vm.runInNewContext(source.slice(start,end),sandbox);
function wav(data, streamed, options={}) {
  const extra=options.extra||0, n=44+extra+data.length;
  const buf=Buffer.alloc(n);
  buf.write('RIFF',0);buf.writeUInt32LE(streamed?0xFFFFFFFF:n-8,4);buf.write('WAVE',8);
  buf.write('fmt ',12);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);
  buf.writeUInt16LE(1,22);buf.writeUInt32LE(8000,24);buf.writeUInt32LE(16000,28);
  buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);
  if(extra) {
    buf.write('JUNK',36);buf.writeUInt32LE(extra-8,40);
    buf.write('data',36+extra);buf.writeUInt32LE(streamed?0xFFFFFFFF:data.length,40+extra);
    data.copy(buf,44+extra);
  } else {
    buf.write('data',36);buf.writeUInt32LE(streamed?0xFFFFFFFF:data.length,40);
    data.copy(buf,44);
  }
  return buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);
}
const pcm=Buffer.alloc(8);
[0,1000,-1000,32767].forEach((v,i)=>pcm.writeInt16LE(v,i*2));
assert.deepStrictEqual(Array.from(sandbox.wavToPcm(wav(pcm,false))),[0,1000,-1000,32767]);
assert.deepStrictEqual(Array.from(sandbox.wavToPcm(wav(pcm,true))),[0,1000,-1000,32767]);
// A genuinely truncated non-streaming chunk should still fail.
const truncated=Buffer.from(wav(pcm,false));
truncated.writeUInt32LE(4096,40);
assert.throws(()=>sandbox.wavToPcm(truncated.buffer.slice(truncated.byteOffset,truncated.byteOffset+truncated.byteLength)),/Truncated WAV/);
assert.deepStrictEqual(Array.from(sandbox.wavToPcm(wav(pcm,true,{extra:12}))),[0,1000,-1000,32767]);
console.log('WAV parser tests passed');
