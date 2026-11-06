const assert=require('assert');
const fs=require('fs');
const vm=require('vm');
const path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../src/pkjs/index.js'),'utf8');
assert(source.includes("Promise.all(pending)"),'Bridge WAV chunks must be fetched in bounded parallel batches');
const start=source.indexOf('var bleFlowGeneration=');
const end=source.indexOf('function startBLESendLoop()',start);
assert(start>=0&&end>start,'Bluetooth pacing helper missing');
const pacing=vm.runInNewContext(source.slice(start,end)+
  '\n({wait:bleAudioWaitMs,ack:bleAudioAck,queue:bleAudioQueueEstimate})');
let t=0,transmitted=0,peak=0,firstPlayback=null;
while(transmitted<80000){
  const size=Math.min(700,80000-transmitted);
  const delay=pacing.wait(size,t);
  if(delay>0){t+=delay;continue;}
  t+=25; // simulated AppMessage callback overhead
  pacing.ack(size,t);
  transmitted+=size;
  if(firstPlayback===null&&transmitted>=3000)firstPlayback=t;
  peak=Math.max(peak,pacing.queue(t));
  t+=10;
}
assert(peak<=7500,'Send-ahead estimation must not overfill its safety limit');
assert(firstPlayback<400,'Initial packets should not incur a 175ms fixed delay');
assert(transmitted===80000,'Full long response must be delivered');
console.log('Audio flow and bounded send-ahead regression checks passed');
