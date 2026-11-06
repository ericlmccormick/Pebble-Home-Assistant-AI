/* Home Assistant Bridge reusable watch audio SDK v1. MIT License.
 * Copy ha_audio.h and ha_audio.c to src/c.
 * The app owns AppMessage registration; pass received dictionaries to
 * ha_audio_handle_message(). No Home Assistant credentials on the watch.
 */
#ifndef HA_BRIDGE_AUDIO_H
#define HA_BRIDGE_AUDIO_H
#include <pebble.h>
void ha_audio_init(void);
void ha_audio_deinit(void);
void ha_audio_stop(void);
bool ha_audio_handle_message(DictionaryIterator *iterator);
void ha_audio_set_volume(float volume);
bool ha_audio_is_playing(void);
#endif
