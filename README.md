# Home Assistant AI — Pebble watch app (Bridge-only)

Home Assistant AI is a Pebble watch interface for Home Assistant Assist, powered by the **Home Assistant Bridge plugin**. All Home Assistant network traffic, credentials, agent selection, TTS generation and WAV conversion are handled by the Bridge. The app does not contain a built-in/direct Home Assistant connection.

## Required installation

1. Install and configure **[Home Assistant Bridge](https://github.com/ericlmccormick/Pebble-HA-plug-in)** v0.2.21 or newer in the Pebble mobile app.
2. In **Bridge settings**, enter the Home Assistant HTTPS URL and long-lived token, choose the default conversation agent and TTS engine, and verify the connection.
3. Install **[Home Assistant AI](https://github.com/ericlmccormick/Pebble-Home-Assistant-AI)** v0.3.0 or newer. Allow its HomeConverse and InvokeAction plugin permissions.
4. Press **Select** to use PebbleOS dictation. Home Assistant's reply appears on the watch, with audio on Pebble watches that have speakers.
5. In app Settings, configure audio on/off, automatic dictation submission, font size, vibration and optional conversation reset. Server credentials and TTS engine selection are managed **only in the Bridge**, not in this app.

The long-press Select conversation mode uses **repeated system dictation**, not a continuous raw microphone stream; the Pebble plugin API does not yet expose an always-open, streamable microphone endpoint. The watch's speaker and audio codec remain native watch code imported from the shared SDK.

## Shared audio SDK

The app uses the versioned **[Bridge Audio SDK](https://github.com/ericlmccormick/Pebble-HA-plug-in/tree/main/sdk)**:

- `src/pkjs/ha_audio.js` — verified progressive WAV transfer, ADPCM encoding, next-sentence TTS prefetch and Bluetooth pacing.
- `src/c/ha_audio.c` — watch 16-KiB ADPCM ring buffer, dual PCM frames, speaker flow control and playback telemetry.
- `src/c/ha_audio.h` — the watch integration API.

The app's `src/pkjs/index.js` now contains only conversation UI, Bridge invocation, settings and SDK integration; it no longer duplicates the TTS decoder/transport. The watch's `src/c/main.c` delegates `AUDIO_*` messages to `ha_audio_handle_message()`.

This app vendors a tested snapshot of the three SDK source files. Future protocol changes should update **all three files together**, and regression-test the native app before release.

## Builds and direct PBW downloads

The `continuous-native-conversation` branch publishes a rolling .pbw:

[Download Home Assistant AI (.pbw)](https://github.com/ericlmccormick/Pebble-Home-Assistant-AI/releases/download/dev-continuous-native-conversation/home-assistant-ai.pbw)

[Download Home Assistant Bridge (.pbw)](https://github.com/ericlmccormick/Pebble-HA-plug-in/releases/download/dev-latest/pebble-home-assistant-plugin.pbw)

[View the app build workflow](https://github.com/ericlmccormick/Pebble-Home-Assistant-AI/actions/workflows/direct-pbw.yml)

The build workflow runs plugin-only architecture, audio transport, and prefetch regression tests and compiles the native watch app. An actual Pebble Time 2 hardware smoke test is still recommended before public distribution.

## Migration from v0.2.x

v0.3.0 intentionally removes the built-in Home Assistant URL/token and direct connections. Earlier app-local direct credentials are deleted on launch, while conversation ID, text-to-speech enabled state, font size, haptics and dictation preferences are preserved. Configure credentials and voice defaults **in the Bridge settings** before running the new app.

For rollback, the previous implementation remains in older Git commits; installing an old PBW is not the recommended long-term method because it duplicates Home Assistant credentials and audio transport logic.
