# SDK 111 experimental conversation mode

This branch deliberately enables `HA_ENABLE_RAW_MIC` in `src/c/main.c`.

Use a separate CloudPebble project if possible. The standard `main` branch retains the known-working tap-to-talk setup.

**If the build fails:** errors about `MicCaptureHandlers`, `mic_capture_start`, or `mic_capture_stop` mean the toolchain does not include the required API. Do not copy new function declarations into an old SDK; older firmware cannot provide the function table entries.

**If the build succeeds:** compilation alone does not guarantee watch firmware support. Grant Microphone permission explicitly on the app's page in the official Pebble mobile app, then long-press Select to test capture.

**If capture starts:** the watch should indicate Listening. Try a short sentence, pause for ~1.3 seconds, and inspect the PebbleKit JS logs and watch response.

**If it crashes or cannot capture:** reinstall the known-working `main` build. The branch uses the same app UUID, so one build replaces the other.

SDK revision 111 raw capture has not been verified with this app on physical hardware; this is an experimental compatibility test.