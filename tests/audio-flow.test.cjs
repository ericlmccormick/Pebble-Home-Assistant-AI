const assert=require('assert'),fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const phone=fs.readFileSync(path.join(root,'src/pkjs/index.js'),'utf8');
const watch=fs.readFileSync(path.join(root,'src/c/main.c'),'utf8');
const sdk=fs.readFileSync(path.join(root,'src/pkjs/ha_audio.js'),'utf8');
const watchSDK=fs.readFileSync(path.join(root,'src/c/ha_audio.c'),'utf8');
const manifest=require('../package.json').pebble;
for(const key of ['COMMAND','TEXT','CHUNK'])
  assert(manifest.messageKeys.includes(key),'Missing shared SDK message key '+key);
const bridge='a74370b6-929c-4ec0-b7ee-2fc6fca8db57';
for(const name of ['HomeConverse','InvokeAction'])
  assert(manifest.usesPermissions.some(p=>p.name===name&&p.plugin===bridge),
    'Missing Bridge permission '+name);
assert(phone.includes("require('./ha_audio').create("),
  'App must import the reusable Bridge SDK');
assert(phone.includes("pluginAction('conversation',args)"),
  'Conversation must route through the Bridge');
assert(!phone.includes('new XMLHttpRequest')&&!phone.includes('new WebSocket')&&
  !phone.includes('/api/tts_get_url')&&!phone.includes('/api/conversation/process')&&
  !phone.includes('HA_URL=')&&!phone.includes('HA_TOKEN='),
  'The app must not contain a direct Home Assistant network client');
assert(!phone.includes('HA_TOKEN')||phone.includes("localStorage.removeItem(key)"),
  'Old direct credentials must be purged');
assert(!phone.includes('USE_BUILTIN_CONNECTION'),
  'Plugin-only app must not expose a built-in-connection toggle');
assert(!phone.includes('startBLESendLoop')&&!phone.includes('function encodeADPCM'),
  'BLE pacing and encoding must live in the shared SDK');
assert(watch.includes('#include "ha_audio.h"'));
assert(watch.includes('ha_audio_handle_message(iterator)'));
assert(!watch.includes('static uint8_t s_ring_buffer'),
  'Watch must not duplicate shared speaker implementation');
assert(!watch.includes('native_mic_')&&!watch.includes('mic_stream_to_phone_'),
  'Plugin-only release must not contain a direct microphone streaming implementation');
assert(watchSDK.includes('#define START_BUFFER_THRESHOLD 2800'));
assert(watchSDK.includes('s_pcm_frames[2][PLAYBACK_PCM_SAMPLES]'));
assert(sdk.includes('streamedAdpcm>=3000 || last'));
assert(sdk.includes('MAX_PENDING_STREAM_SEGMENTS=8'));
assert(sdk.includes('BLE_SAFE_QUEUE_BYTES=9000'));
console.log('Plugin-only app architecture and shared SDK contract checks passed');
