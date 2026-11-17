/*
 * content/youtube.js
 *
 * Runs inside every www.youtube.com tab (from document_start). It does four
 * things:
 *   1. Turns the "hide X" settings into data-dfyt-* attributes on <html>;
 *      content/youtube.css does the actual hiding.
 *   2. Turns autoplay off on watch pages        (setting `disableAutoplay`)
 *   3. Opens videos without their playlist      (setting `disablePlaylists`)
 *   4. Removes the "(3)" notification count from the tab title
 *                                                (with `hideNotificationBell`)
 *
 * YouTube is a single-page app: clicking a video doesn't load a new page, it
 * swaps content in place and then fires its own `yt-navigate-finish` event.
 * We listen to that event instead of the old 250 ms polling loop, which never
 * stopped on today's YouTube and added one more `resize` listener on every
 * pass (a growing leak).
 *
 * Everything that listens or observes is set up only while the extension is
 * active and torn down when it is turned off.
 */
"use strict";

// Settings key (in `visibility`) -> attribute read by youtube.css.
const HIDE_ATTRIBUTES = {
  hideFeed: "data-dfyt-hide-feed",
  hideRecommended: "data-dfyt-hide-home-shelves",
  hideNotificationBell: "data-dfyt-hide-bell",
  hideSubBar: "data-dfyt-hide-guide",
  hideNonLists: "data-dfyt-only-lists",
  hideTrending: "data-dfyt-hide-trending",
  hideSidebar: "data-dfyt-hide-related-list",
  hidePlaylist: "data-dfyt-hide-playlist",
  hideLiveChat: "data-dfyt-hide-chat",
  hideRelated: "data-dfyt-hide-endscreen",
  hideMerch: "data-dfyt-hide-merch",
  hideComments: "data-dfyt-hide-comments",
};

let settings = null;
let listening = false;

const isOn = (key) => settings.active && settings[key];
const isHidden = (key) => settings.active && settings.visibility[key];

/* ---------------------------------------------------------------------- */
/* Applying settings                                                      */
/* ---------------------------------------------------------------------- */

function applySettings(newSettings) {
  settings = newSettings;
  const root = document.documentElement;

  for (const [key, attribute] of Object.entries(HIDE_ATTRIBUTES)) {
    root.toggleAttribute(attribute, isHidden(key));
  }
  // Releases the anti-flash rule in youtube.css. Set even when inactive,
  // otherwise the home feed would stay invisible.
  root.toggleAttribute("data-dfyt-ready", true);

  setListening(settings.active);
  markHomePage();
  updateTitleWatcher();
  disableAutoplay();
  syncLiveChat();
  watchChatState();
  settlePage();
}

/* ---------------------------------------------------------------------- */
/* Things we add to the page: wait until YouTube has drawn their place    */
/* ---------------------------------------------------------------------- */

// Places our buttons and marks the Shop button. Safe to call often: each
// part only touches the page when something is missing or out of place.
function refreshPageFeatures() {
  markShopButton();
  updateTranscriptButtons(); // transcript.js
  updateAudioMode(); // audio-mode.js
}

// Fix (v2.0.12): after a page (re)load our buttons often didn't appear until
// the extension was switched off and on. YouTube fires yt-navigate-finish /
// yt-page-data-updated when the video's *data* is ready, but it draws the
// Like buttons, the description and the player controls a bit later, so we
// found nothing and gave up. Now, after each navigation, we keep trying for
// a few seconds as YouTube adds elements:
//   - a MutationObserver tells us when the page changes,
//   - but we refresh at most every 150 ms (YouTube changes the page hundreds
//     of times while loading; one check per change would be wasteful),
//   - and everything stops after 10 s.
// setTimeout rather than requestAnimationFrame: animation frames are paused
// in background tabs, and a video opened in a background tab must work too.
const SETTLE_MS = 10000;
const SETTLE_THROTTLE_MS = 150;
let settleObserver = null;
let settleStopTimer = null;
let settleRefreshTimer = null;

function stopSettling() {
  settleObserver?.disconnect();
  settleObserver = null;
  clearTimeout(settleStopTimer);
  clearTimeout(settleRefreshTimer);
  settleRefreshTimer = null;
}

function settlePage() {
  stopSettling();
  refreshPageFeatures();
  if (!settings.active) return;

  settleObserver = new MutationObserver(() => {
    settleRefreshTimer ??= setTimeout(() => {
      settleRefreshTimer = null;
      refreshPageFeatures();
    }, SETTLE_THROTTLE_MS);
  });
  settleObserver.observe(document.querySelector("ytd-app") ?? document.documentElement, {
    childList: true,
    subtree: true,
  });
  settleStopTimer = setTimeout(stopSettling, SETTLE_MS);
}

// A tab opened in the background may only be drawn once you look at it.
function onVisibilityChange() {
  if (document.visibilityState === "visible") settlePage();
}

// Fix (v2.0.12): duplicated buttons. When the extension is reloaded or
// switched off and on, Firefox injects this script again into open tabs, but
// the elements the previous copy added stay in the page (with their code
// gone, they do nothing). Remove them before adding ours, otherwise each
// off/on adds another set.
function removeLeftoversFromPreviousRun() {
  const ours = "#dfyt-transcript-button, #dfyt-copy-transcript-button, #dfyt-audio-button, #dfyt-audio-tooltip";
  for (const element of document.querySelectorAll(ours)) element.remove();
}

/* ---------------------------------------------------------------------- */
/* Shop button (with `hideMerch`)                                         */
/* ---------------------------------------------------------------------- */

// v2.0.6. The "Shop" button next to Like has no id or element name of its
// own, only a translated label ("Boutique", "Shopping"...). What doesn't
// change with the language is its shopping-bag icon, so we find it by the
// start of the icon's SVG path (taken from a saved copy of the page) and mark
// it; youtube.css hides marked buttons.
// Why not a pure-CSS `:has(path[d^=...])`: YouTube animates SVG paths (e.g.
// the Like animation), and such a rule would make Firefox re-check on each
// animation frame. This querySelector runs once per navigation instead.
const SHOP_ICON = 'yt-button-view-model path[d^="M16 6h4a2 2 0 012 2v10"]';

function markShopButton() {
  if (!isHidden("hideMerch") || location.pathname !== "/watch") return;
  const actionBar = document.querySelector("ytd-watch-metadata #top-level-buttons-computed");
  if (!actionBar) return;
  // YouTube reuses button elements from one video to the next: an element
  // that was the Shop button may now be another button. Clear the old marks
  // first so we never hide the wrong one.
  for (const marked of actionBar.querySelectorAll("[data-dfyt-shop-button]")) {
    marked.removeAttribute("data-dfyt-shop-button");
  }
  for (const icon of actionBar.querySelectorAll(SHOP_ICON)) {
    icon.closest("yt-button-view-model").setAttribute("data-dfyt-shop-button", "");
  }
}

// CSS can't see the URL, and a few rules (the chips bar) must apply on Home
// only, even for elements outside the home page's container.
function markHomePage() {
  document.documentElement.toggleAttribute(
    "data-dfyt-home",
    settings.active && location.pathname === "/",
  );
}

// Adds or removes all page listeners in one place, so nothing is left behind
// when the extension is turned off.
function setListening(on) {
  if (on === listening) return;
  listening = on;
  const method = on ? "addEventListener" : "removeEventListener";
  document[method]("yt-navigate-finish", onNavigateFinish);
  document[method]("yt-page-data-updated", settlePage);
  document[method]("visibilitychange", onVisibilityChange);
  // Capture phase on window: we run before YouTube's own click handlers,
  // which are attached to the link elements themselves.
  window[method]("click", onLinkClick, true);
  window[method]("pointerdown", onLinkPointerDown, true);
}

function onNavigateFinish() {
  // YouTube rewrites the tab title on each navigation, and the player
  // (with its autoplay button) may have been rebuilt.
  markHomePage();
  updateTitleWatcher();
  disableAutoplay();
  syncLiveChat();
  watchChatState(); // the watch page element exists only after the first video
  settlePage();
}

/* ---------------------------------------------------------------------- */
/* Live chat                                                              */
/* ---------------------------------------------------------------------- */

// Performance fix (v2.0.3). Before, "Hide live chat" was CSS only: the chat
// was invisible but still fully running in its iframe, receiving and
// rendering every message. That slowed streams down, and turning the
// extension off meant laying out that whole backlog at once (the 3-4 s
// freeze). It also left YouTube believing the chat was open, so it kept room
// for it beside the player (the black box), which v2.0.1/2.0.2 patched up
// with fake `resize` events that made YouTube redo its whole layout.
//
// Now we collapse the chat the same way YouTube's own "Hide chat" button
// does. YouTube's code then points the chat iframe at about:blank (the
// chat stops completely) and lays out the page for "no chat" by itself.
//
// How: YouTube's components talk through a DOM event named "yt-action" whose
// `detail` names an action; <ytd-live-chat-frame> handles
// "yt-set-live-chat-collapsed-state-action". (Names read from YouTube's
// code, Nov 2026; if YouTube renames them, the CSS still hides the chat.)

// Frames we collapsed, so that unticking the option (or turning the extension
// off) re-opens only a chat that *we* closed, never one you closed yourself.
const chatsCollapsedByUs = new WeakSet();

// Asks a YouTube component to run one of its internal actions, the way
// YouTube's own components do.
function sendYtAction(target, actionName, args) {
  // A content script's objects are invisible to the page's scripts in Firefox.
  // cloneInto() copies `detail` into the page's world so YouTube can read it.
  const detail = cloneInto({ actionName, optionalAction: true, args, returnValue: [] }, window);
  target.dispatchEvent(new CustomEvent("yt-action", { bubbles: true, composed: true, detail }));
}

function setChatCollapsed(frame, collapsed) {
  sendYtAction(frame, "yt-set-live-chat-collapsed-state-action", [
    { setLiveChatCollapsedStateAction: { collapsed } },
  ]);
}

function syncLiveChat() {
  const frame = document.querySelector("ytd-live-chat-frame");
  if (!frame) return;
  // YouTube reflects the frame's state in a `collapsed` attribute.
  const isOpen = !frame.hasAttribute("collapsed");

  if (isHidden("hideLiveChat")) {
    if (isOpen) {
      setChatCollapsed(frame, true);
      chatsCollapsedByUs.add(frame);
    }
  } else if (!isOpen && chatsCollapsedByUs.has(frame)) {
    setChatCollapsed(frame, false);
    chatsCollapsedByUs.delete(frame);
  }
}

// YouTube re-opens the chat by itself: on each new video (new data resets
// the "hidden by user" state) and sometimes when switching layouts. It shows
// that by putting `live-chat-present-and-expanded` back on <ytd-watch-flexy>.
// We watch that single attribute on that single element, which is almost
// free, and collapse the chat again when it appears.
let chatStateObserver = null;

function watchChatState() {
  chatStateObserver?.disconnect();
  chatStateObserver = null;
  if (!isHidden("hideLiveChat")) return;

  const watchPage = document.querySelector("ytd-watch-flexy");
  if (!watchPage) return;
  chatStateObserver = new MutationObserver(syncLiveChat);
  chatStateObserver.observe(watchPage, {
    attributes: true,
    attributeFilter: ["live-chat-present-and-expanded"],
  });
}

/* ---------------------------------------------------------------------- */
/* Notification count in the tab title                                    */
/* ---------------------------------------------------------------------- */

let titleObserver = null;

// Fix: the old regex / *\([0-9]+\)/ wasn't anchored, so a video called
// "Best of (2019)" lost its "(2019)". The count is always at the start, and
// can be "(9+)".
function stripTitleCount() {
  const cleaned = document.title.replace(/^\(\d+\+?\)\s*/, "");
  // Only write when something changes: writing triggers our own observer,
  // and this check is what stops that from looping.
  if (cleaned !== document.title) document.title = cleaned;
}

// Fix: the old version stripped the count once, and YouTube put it back on
// the next navigation or notification. Now we watch <title> for as long as
// the option is on.
function updateTitleWatcher() {
  const wanted = isHidden("hideNotificationBell");
  const titleElement = document.querySelector("head > title");

  if (!wanted || !titleElement) {
    // No <title> yet at document_start: this runs again on yt-navigate-finish.
    titleObserver?.disconnect();
    titleObserver = null;
    return;
  }
  if (!titleObserver) {
    titleObserver = new MutationObserver(stripTitleCount);
    titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
  }
  stripTitleCount();
}

/* ---------------------------------------------------------------------- */
/* Autoplay                                                               */
/* ---------------------------------------------------------------------- */

const AUTOPLAY_WAIT_MS = 15000;
let autoplayObserver = null;
let autoplayTimeout = null;

function stopWaitingForAutoplayButton() {
  autoplayObserver?.disconnect();
  autoplayObserver = null;
  clearTimeout(autoplayTimeout);
}

// Returns true once the button exists (whether or not we had to click it).
// `scope` (v2.0.3): search inside the player only, not the whole page, since
// this runs on every batch of changes the player makes while we wait.
function clickAutoplayButtonIfOn(scope = document) {
  const button = scope.querySelector(".ytp-autonav-toggle-button");
  if (!button) return false;
  if (button.getAttribute("aria-checked") === "true") button.click();
  return true;
}

// Fix: the old code clicked `#toggle` after a fixed 5 s. That generic id
// could belong to some other element, and the delay was wrong both for slow
// loads and for in-page navigation. We now look for the real autoplay button.
// If the player hasn't built it yet, a MutationObserver waits for it, limited
// to the player element and disconnected as soon as the button appears (or
// after 15 s, e.g. on live streams that have no autoplay button).
function disableAutoplay() {
  stopWaitingForAutoplayButton();
  if (!isOn("disableAutoplay") || location.pathname !== "/watch") return;
  if (clickAutoplayButtonIfOn()) return;

  const player = document.querySelector("ytd-player") ?? document.body;
  if (!player) return; // page still loading; yt-navigate-finish will call us
  autoplayObserver = new MutationObserver(() => {
    if (clickAutoplayButtonIfOn(player)) stopWaitingForAutoplayButton();
  });
  autoplayObserver.observe(player, { childList: true, subtree: true });
  autoplayTimeout = setTimeout(stopWaitingForAutoplayButton, AUTOPLAY_WAIT_MS);
}

/* ---------------------------------------------------------------------- */
/* Opening videos without their playlist                                  */
/* ---------------------------------------------------------------------- */

// Links whose href we already cleaned on pointerdown (see below). A WeakSet
// doesn't keep removed elements in memory.
const cleanedLinks = new WeakSet();

// Finds the link the event happened on. composedPath() also sees through
// shadow DOM, which closest() would not.
function linkFromEvent(event) {
  return event.composedPath().find((node) => node.localName === "a" && node.href);
}

// Returns the link's URL without its playlist, or null if it isn't a video
// link inside a playlist.
// Fix: the old strip_playlist cut everything after "&list=", so a "&t=1m30s"
// timestamp was lost too, and it missed "?list=" as the first parameter.
// With URL, only the playlist parameters are removed.
function playlistFreeUrl(link) {
  const url = new URL(link.href);
  if (url.hostname !== location.hostname || url.pathname !== "/watch") return null;
  if (!url.searchParams.has("list")) return null;
  for (const parameter of ["list", "index", "start_radio"]) url.searchParams.delete(parameter);
  return url.href;
}

// Plain left click (or Enter on a focused link).
// Fix: the old version rewrote every <a href> on the page once, 1.5 s after
// load. That missed links added later, and didn't work anyway: YouTube
// navigates using data stored on the element, not its href. So we stop the
// click before YouTube sees it and load the cleaned URL ourselves. The cost
// is a full page load for that click instead of YouTube's in-place one.
function onLinkClick(event) {
  if (!isOn("disablePlaylists")) return;
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    return; // opening in a new tab/window: the browser uses the href we cleaned on pointerdown
  }
  const link = linkFromEvent(event);
  if (!link) return;
  const target = cleanedLinks.has(link) ? link.href : playlistFreeUrl(link);
  if (!target) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(target);
}

// Middle click, Ctrl+click and the context menu ("Open in new tab") use the
// href directly, so clean it just before the browser reads it.
function onLinkPointerDown(event) {
  if (!isOn("disablePlaylists")) return;
  const link = linkFromEvent(event);
  const target = link && playlistFreeUrl(link);
  if (!target) return;
  link.href = target;
  // Remember it: a later plain click on this link must still be stopped,
  // even though its href no longer contains "list=".
  cleanedLinks.add(link);
}

/* ---------------------------------------------------------------------- */
/* Start                                                                  */
/* ---------------------------------------------------------------------- */

removeLeftoversFromPreviousRun();

// Register for changes before the first load finishes; if a change arrives
// first, the result of the (older) initial load is ignored.
DFSettings.onChange(applySettings);
DFSettings.load()
  .catch((error) => {
    console.error("Focus roc'h: could not read settings, using defaults.", error);
    return DFSettings.defaults();
  })
  .then((loaded) => {
    if (settings === null) applySettings(loaded);
  });
