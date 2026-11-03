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

## Security

Use a **valid HTTPS endpoint** accessible from the phone, including away from home if desired. The app rejects HTTP by default. The access token is stored in PebbleKit JS localStorage, not an OS secure keychain; grant it only the privileges necessary and keep the app private until reviewed. The TTS audio URL returned by HA may advertise an internal address; the app deliberately uses its relative proxy `path` against the configured HTTPS root, to avoid exposing or depending on LAN-only URLs.

## Compatibility and limitations

The original project's C dictation, scrolling, ADPCM speaker code and BLE chunk transport are retained. Voice playback is selected for Emery (Pebble Time 2) when supported; other platforms receive text. This is a first implementation and has **not been compiled or tested on hardware**. The original package targets basalt, chalk, diorite, emery. Additional hardware support requires explicit build and on-device validation.

No in-app automatic TTS entity discovery, no audio input upload to Home Assistant STT, and no automatic Assist pipeline routing yet. Server-side TTS is used, but watch-to-phone speech transcription still uses Pebble dictation.

## Manual tests

1. Set the URL/token and ask the current time or light status.
2. Follow up with "what about the kitchen?" to test conversation ID.
3. Test new-conversation reset.
4. Test HA command execution with a harmless light.
5. Verify TTS PCM WAV output and speaker playback with a short reply and multiple sentences.
6. Verify wrong token, disconnected network, and missing TTS entity fail safely.
7. Build/re-run regression tests for each platform before publication.

References: https://developers.home-assistant.io/docs/intent_conversation_api/ and https://www.home-assistant.io/integrations/tts/
