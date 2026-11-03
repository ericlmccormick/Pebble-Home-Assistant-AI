# Home Assistant AI — Pebble watch app

Home Assistant AI is a separate app built from the proven [Pebble Gemini](https://github.com/ericlmccormick/Pebble_Gemini) watch UI and ADPCM audio engine.

**Uses Home Assistant for both the conversation agent and text-to-speech.** No Gemini API key and no Google TTS account are required.

## Setup

In Home Assistant, configure your preferred conversation agent and TTS entity, such as Piper. In your HA user profile create a long-lived access token. In Pebble app settings, enter:

- **Home Assistant HTTPS URL**: the externally accessible HTTPS root, not the /api endpoint.
- **Long-lived access token**: stored locally in the companion phone; never commit it.
- **Conversation agent** (optional): for example `conversation.home_assistant`; leave blank to use HA's default conversation agent.
- **TTS entity**: for example `tts.piper`. Select the same TTS provider/voice you configured in Home Assistant. The REST TTS endpoint does not automatically select the Assist pipeline's TTS entity.
- Toggle **Speak responses on watch**. Text replies are always displayed. Text-only watches omit playback.
- **Start new conversation** resets the stored conversation ID.

Watch dictation is transcribed by Pebble's normal dictation service. Home Assistant handles intent/conversation via `POST /api/conversation/process`. The response text is passed back to Home Assistant `POST /api/tts_get_url`, requesting `wav`, mono, 8000 Hz, signed 16-bit PCM. The resulting `/api/tts_proxy/...` audio is downloaded, parsed as RIFF/WAV and compressed to IMA-ADPCM for transport to the watch.

If your HA TTS provider cannot transcode to 8-kHz PCM WAV, the app will show text but playback may fail. HA uses FFmpeg for transcoding where supported.

## Experimental full conversation mode (raw microphone)

The full hands-free streaming pipeline is now implemented **behind the HA_ENABLE_RAW_MIC compile flag**. It is not enabled in the standard CloudPebble build because the SDK from the last user's compile log was 4.33.1 and the microphone capture API requires **PebbleOS SDK revision 111 and matching firmware**. A build passing with this flag OFF only proves that tap-to-talk still compiles.

When active, it works as follows:

1. **Tap Select** = the normal Pebble dictation-to-Home-Assistant path.
2. **Long press Select (500ms)** = enable/disable hands-free conversation.
3. The watch opens local raw microphone capture at 16,000 Hz, computes simple energy-based voice activity detection, keeps 200ms of preroll and waits for three 20ms speech frames.
4. After speech begins, it compresses each frame to IMA ADPCM; two frames are sent per AppMessage (~320 bytes every 40ms) with sequence numbers and ACK-based pacing.
5. After 1.3s of silence (or 22s max), it sends end-of-audio, and **stops recording** while Home Assistant processes the audio.
6. The phone decodes PCM, authenticates to Home Assistant's `/api/websocket`, runs the preferred Assist pipeline from `stt` to `intent`, and retains the conversation ID across turns.
7. It returns the text response to the watch, uses the existing Home Assistant TTS endpoint to synthesize spoken audio, and returns to listening **only after watch speaker playback ends**.
8. Long press again, app exit, or microphone permission revocation ends recording; if capability/permission is absent it reports unavailable instead of claiming to record.

Speech audio is transmitted **only when local voice activity is detected**, rather than recording/transmitting silence constantly. It has no wake word, so any nearby conversation that triggers the VAD may be sent for transcription while the mode is active. Enable this mode only when you intend to be heard. This first-cut energy VAD can false-trigger in noise or miss unusually quiet speech.

### Requirements to enable

- Target watch running firmware supporting microphone capture SDK **revision 111 or newer** (not just Pebble SDK 4.x). An older firmware cannot run an app calling the newer function table.
- Matching SDK with `mic_capture_start`, `mic_capture_stop`, `MicCaptureHandlers` and associated types.
- A companion phone with its experimental microphone permission feature enabled, and explicit **Microphone** permission granted to this app. The manifest declares `manifestVersion: 2` and `usesPermissions: ["Microphone"]`. If the permission is denied the watch reports the mic unavailable.
- Build with `HA_ENABLE_RAW_MIC` defined, e.g. uncomment `#define HA_ENABLE_RAW_MIC 1` immediately after `#include <pebble.h>` in `src/c/main.c`, or add `-DHA_ENABLE_RAW_MIC` to the C compilation flags on the compatible SDK. This must be done only when both SDK and firmware meet the API requirement.
- The Home Assistant URL must be HTTPS and accessible to your phone. The watch app uses PebbleKit JS's WebSocket transport to `wss://<HA>/api/websocket`. Your preferred Assist pipeline must have STT and the desired Google AI conversation agent. The optional **Assist pipeline ID** setting selects a non-default pipeline.
- `tts.home_assistant_cloud` remains the separate TTS entity for speaker playback. Thus the full pipeline runs STT + intent, while the existing dedicated TTS path handles 8 kHz PCM WAV conversion for the Pebble speaker.

**Compatibility notice:** this code has not yet been built against SDK revision 111, tested with production firmware/permissions, or validated end-to-end over actual Bluetooth hardware. It is an implementation for that newer SDK, not a verified working firmware-independent feature. The normal build remains safe when `HA_ENABLE_RAW_MIC` is undefined.

### Debugging

Watch status `Listening...` indicates capture started; `Processing...` indicates a detected utterance has ended. A `Raw mic needs SDK 111` status means the build does not support raw capture. `Mic unavailable` indicates the SDK API refused to start (permission, busy, or unsupported firmware). On the phone, inspect `Home Assistant conversation:` errors for authentication, STT pipeline, timeout, audio packet loss, or socket failures.

CI validates JS syntax, RIFF/WAV streaming audio parsing, a simulated Assist WebSocket session, and message-command contracts. It does **not** emulate hardware microphone recording, Bluetooth throughput, or the SDK revision 111 native compiler.

## Security

Use a **valid HTTPS endpoint** accessible from the phone, including away from home if desired. The app rejects HTTP by default. The access token is stored in PebbleKit JS localStorage, not an OS secure keychain; grant it only the privileges necessary and keep the app private until reviewed. The TTS audio URL returned by HA may advertise an internal address; the app deliberately uses its relative proxy `path` against the configured HTTPS root, to avoid exposing or depending on LAN-only URLs.

## Compatibility and limitations

The original project's C dictation, scrolling, ADPCM speaker code and BLE chunk transport are retained. Voice playback is selected for Emery (Pebble Time 2) and Flint (Pebble 2 Duo) when available; other platforms receive text. The configured targets are basalt, chalk, diorite, emery, flint and gabbro. The previously supplied CloudPebble build log confirmed the four original targets but the new targets and experimental raw microphone path still need on-device validation.

No in-app automatic TTS entity discovery yet. The default build continues to use Pebble STT. The optional SDK 111 raw microphone build uses Home Assistant Assist WebSocket STT and the preferred (or explicitly configured) Assist pipeline.

## Manual tests

1. Set the URL/token and ask the current time or light status.
2. Follow up with "what about the kitchen?" to test conversation ID.
3. Test new-conversation reset.
4. Test HA command execution with a harmless light.
5. Verify TTS PCM WAV output and speaker playback with a short reply and multiple sentences.
6. Verify wrong token, disconnected network, and missing TTS entity fail safely.
7. Build/re-run regression tests for each platform before publication.

References: https://developers.home-assistant.io/docs/intent_conversation_api/ and https://www.home-assistant.io/integrations/tts/
