/*
 * content/live-chat.js
 *
 * Runs inside the live chat iframe (youtube.com/live_chat and
 * /live_chat_replay), and in the chat's pop-out window. Its only job: turn
 * the `lightChat` setting into an attribute on <html> for live-chat.css.
 *
 * Kept separate from youtube.js on purpose: the chat is a different page with
 * none of the things youtube.js handles (feed, player, links...), and this
 * script should stay as small as possible since the chat restarts every time
 * YouTube moves it.
 */
"use strict";

function applyChatSettings(settings) {
  document.documentElement.toggleAttribute(
    "data-dfyt-light-chat",
    settings.active && settings.lightChat,
  );
}

// Same pattern as youtube.js: listen first, then load, and ignore the
// initial load if a change already arrived.
let chatSettingsApplied = false;
DFSettings.onChange((settings) => {
  chatSettingsApplied = true;
  applyChatSettings(settings);
});
DFSettings.load()
  .catch(() => DFSettings.defaults())
  .then((settings) => {
    if (!chatSettingsApplied) applyChatSettings(settings);
  });
