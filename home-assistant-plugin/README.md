# Home Assistant Bridge — Pebble Plugin Preview

Standalone, phone-side Pebble plugin for reusable access to a user's Home Assistant installation.

## Install

1. Enable **Settings → Plugins → Plugins / permissions preview** in the Pebble mobile app.
2. Build or download the GitHub Actions **Build Home Assistant Plugin** artifact.
3. Extract and sideload the plugin-only `.pbw`. It won't appear as a watchapp.
4. Open the **Home Assistant Bridge** plugin's settings page in Pebble.
5. Set your externally reachable **HTTPS** Home Assistant URL and a long-lived access token.
6. Grant the network permissions; tap **Test connection**.
7. Install an app using the plugin and grant its declared read/converse/control permissions.

Token storage uses `Pebble.secureStorage`, private to the plugin and backed by the phone keystore. A plugin-enabled watchapp doesn't receive the token.

## Public interface

Plugin UUID: `a74370b6-929c-4ec0-b7ee-2fc6fca8db57`.

Sources:

- `home_assistant/configured`: whether a URL and token are configured.
- `home_assistant/entity`: state, numeric/boolean readings, name, unit, domain and ID from HA states. Up to 400 entries per update; use `get_state` for an entity not in the first update.

Actions:

| Action | Arguments | Permission | Purpose |
| --- | --- | --- | --- |
| `get_state` | `{entity_id}` | HomeRead | Read one entity |
| `list_states` | `{domain?, limit?}` | HomeRead | List up to 100 entity states |
| `read_api` | `{path}` | HomeRead | Allowlisted read-only HA API GET |
| `conversation` | `{text, agent_id?, conversation_id?}` | HomeConverse | Call HA conversation/process |
| `render_template` | `{template}` | HomeControl | Render a trusted HA Jinja template |
| `call_service` | `{domain,service,data?,target?}` | HomeControl | Invoke an arbitrary HA service |
| `fire_event` | `{event_type,event_data?}` | HomeControl | Fire an HA event |

The generic service and event operations can affect locks, alarms, garage doors or other sensitive entities. Use a dedicated least-privileged HA account, and grant `HomeControl` only to trusted apps. Plugin permissions are enforced by the Pebble host, not by these JavaScript handlers themselves.

Action success results use `{ok:true, text:"<JSON or text>", refreshed:[...]}`; parse `text` for returned structured data. Errors use Pebble standard error codes.

Example consumer (from PebbleKit JS):

```js
const PLUGIN = "a74370b6-929c-4ec0-b7ee-2fc6fca8db57";
const result = await Pebble.invokeAction({
  plugin: PLUGIN, action: "get_state", args: { entity_id: "sensor.outdoor_temperature" }
});
if (result.ok) {
  const entity = JSON.parse(result.text);
  console.log(entity.state);
}
```

Consumer manifests must declare `{ "name": "HomeRead", "plugin": "<UUID>" }` and `{ "name": "InvokeAction", "plugin": "<UUID>" }`. Add `HomeConverse` or `HomeControl` for the other actions as required.

## Watchapp compatibility

Home Assistant AI v0.2.0 includes a **Use Home Assistant plugin for text requests** settings toggle. The plugin-backed path uses `conversation` for one-shot dictation, without copying the token into watchapp storage, and currently displays the response as text.

**Limitation:** Native watch microphone streaming, Assist STT and audio TTS still use the existing direct Home Assistant connection. Pebble plugin actions are request-scoped and do not currently replace a long-running WebSocket and binary audio transport. Keep the direct setup for hands-free voice. Do not enable the plugin toggle expecting it to migrate that voice connection automatically.

## Build

GitHub Actions: `.github/workflows/build-ha-plugin.yml` packages the plugin with a pinned version of Pebble's official `pack-plugin-pbw.py`. No SDK or local installation is necessary for the plugin-only package.

The Pebble plugin API is still in preview. Test through sideloading and do not publish plugin-dependent apps to the public store until Pebble's release guidance changes.
