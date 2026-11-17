/*
 * content/audio-mode.js
 *
 * Setting `audioModeButton`: a headphones button in the player's control bar
 * (next to theatre mode / full screen). Clicking it switches "audio mode" on
 * or off. In audio mode:
 *   - the picture is hidden (a headphones icon is shown instead);
 *   - video quality is forced to the lowest level, 144p.
 *
 * Why 144p and not "no video at all": YouTube's player does have an internal
 * audio-only mode, but YouTube decides when to use it (TVs, YouTube Music,
 * podcasts) from what its servers send; there is no way to switch it on from
 * outside without tampering with the player's network requests, which is
 * fragile and can break playback. Sound is a separate stream whose quality
 * doesn't depend on the video's, so you hear exactly the same thing. 144p
 * video is roughly 0.1 Mb/s against 3-5 Mb/s at 1080p, about 90-95% less data.
 *
 * Quality is changed through the player's public method
 * setPlaybackQualityRange (the same one YouTube's quality menu uses). YouTube
 * remembers the chosen quality for all future videos, so we save your usual
 * quality when audio mode starts and put it back when it ends.
 *
 * Audio mode is remembered (until you switch it off) and shared by all YouTube
 * tabs. It lives in storage.local, not in the synced settings: how much data
 * you can afford is a matter of this device and connection.
 *
 * Loaded before youtube.js (see manifest.json) and called from it; it uses
 * `settings` and isOn() defined there.
 */
"use strict";

const AUDIO_MODE_KEY = "audioMode";
const QUALITY_BEFORE_KEY = "audioModeQualityBefore";
const HEADPHONES_PATH =
  "M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1a7 7 0 0 1 14 0v1h-4v8h4c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z";

let audioModeWanted = false; // your choice, from storage.local
let audioModeApplied = false; // whether this tab currently forces 144p
let qualityForcedFor = null; // id of the video we last forced to 144p
let audioButton = null;

// The player's methods belong to the page's JavaScript. In Firefox a content
// script sees page objects through a protective "Xray" view that hides them;
// `wrappedJSObject` lifts that view so we can call the player's own methods.
// We only call them with plain strings, which is safe to pass across.
function playerApi() {
  return document.querySelector("#movie_player")?.wrappedJSObject ?? null;
}

// Called by youtube.js when settings change and on each new page/video.
function updateAudioMode() {
  if (!settings) return; // settings not loaded yet; called again once they are
  placeAudioButton();

  const effective = isOn("audioModeButton") && audioModeWanted;
  document.documentElement.toggleAttribute("data-dfyt-audio-mode", effective);
  audioButton?.setAttribute("aria-pressed", String(effective));
  audioButton?.setAttribute("aria-label", audioButtonLabel());
  if (tooltipVisible()) showTooltip(); // refresh the text if hovered while it changes

  const player = playerApi();
  if (typeof player?.setPlaybackQualityRange !== "function") return;
  if (effective) {
    // Once per video. v2.0.12: this function now runs many times while a
    // page loads (see settlePage in youtube.js), and asking the player to
    // switch quality each time could make it re-buffer. getVideoData() is
    // another public player method; its video_id tells us which video it is.
    const videoId = player.getVideoData?.()?.video_id || location.href;
    if (videoId !== qualityForcedFor) {
      player.setPlaybackQualityRange("tiny", "tiny");
      qualityForcedFor = videoId;
    }
    audioModeApplied = true;
  } else if (audioModeApplied) {
    restoreQuality(player);
    audioModeApplied = false;
    qualityForcedFor = null;
  }
}

async function restoreQuality(player) {
  const stored = await browser.storage.local.get(QUALITY_BEFORE_KEY);
  const quality = stored[QUALITY_BEFORE_KEY] ?? "auto";
  player.setPlaybackQualityRange(quality, quality);
}

/* ---------------------------------------------------------------------- */
/* The button                                                             */
/* ---------------------------------------------------------------------- */

function placeAudioButton() {
  const player = isOn("audioModeButton") ? document.querySelector("#movie_player") : null;
  // Current player: the theatre/full-screen group. Fallback: the whole right side.
  const controls =
    player?.querySelector(".ytp-right-controls-right") ??
    player?.querySelector(".ytp-right-controls");
  if (!controls) {
    audioButton?.remove();
    return;
  }
  audioButton ??= createAudioButton();
  if (controls.firstElementChild !== audioButton) controls.prepend(audioButton);
}

// `ytp-button` gives it the same size, colour and hover effect as the
// player's own buttons. Built with DOM methods (no innerHTML).
function createAudioButton() {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", HEADPHONES_PATH);
  svg.append(path);

  const button = document.createElement("button");
  button.type = "button";
  button.id = "dfyt-audio-button";
  button.className = "ytp-button";
  button.setAttribute("aria-label", audioButtonLabel());
  button.append(svg);
  button.addEventListener("click", onAudioButtonClick);
  // Hover and keyboard focus show the tooltip, like the player's buttons.
  button.addEventListener("mouseenter", showTooltip);
  button.addEventListener("focus", showTooltip);
  button.addEventListener("mouseleave", hideTooltip);
  button.addEventListener("blur", hideTooltip);
  return button;
}

/* ---------------------------------------------------------------------- */
/* Tooltip, in the player's own style (v2.0.10)                           */
/* ---------------------------------------------------------------------- */

// The player attaches its tooltips to its buttons with an internal function
// we can't call. But their look comes entirely from the player's stylesheet,
// through the `ytp-tooltip` classes. So we build our own tooltip element with
// the same classes and structure as a player button tooltip (read from
// YouTube's player code): it looks identical, including the frosted-glass
// style, and never interferes with YouTube's own tooltip element.
// The player's CSS shows it when aria-hidden isn't "true" (with its fade).

// Text in the language of YouTube's interface (<html lang>), English otherwise.
const AUDIO_LABELS = {
  fr: { off: "Mode audio (économise les données)", on: "Afficher la vidéo" },
  en: { off: "Audio only (saves data)", on: "Show video" },
  zh: { off: "仅音频（节省流量）", on: "显示视频" },
};

function audioButtonLabel() {
  const lang = document.documentElement.lang?.slice(0, 2);
  const labels = AUDIO_LABELS[lang] ?? AUDIO_LABELS.en;
  return audioModeWanted && isOn("audioModeButton") ? labels.on : labels.off;
}

let tooltip = null;
let tooltipText = null;

function createTooltip() {
  const element = document.createElement("div");
  element.className = "ytp-tooltip ytp-bottom";
  element.id = "dfyt-audio-tooltip";
  element.setAttribute("aria-hidden", "true");
  const wrapper = document.createElement("div");
  wrapper.className = "ytp-tooltip-text-wrapper";
  const bottomText = document.createElement("div");
  bottomText.className = "ytp-tooltip-bottom-text";
  tooltipText = document.createElement("span");
  tooltipText.className = "ytp-tooltip-text";
  bottomText.append(tooltipText);
  wrapper.append(bottomText);
  element.append(wrapper);
  return element;
}

function tooltipVisible() {
  return tooltip?.getAttribute("aria-hidden") === "false";
}

function showTooltip() {
  const player = audioButton?.closest(".html5-video-player");
  if (!player) return;
  tooltip ??= createTooltip();
  // The tooltip is positioned inside the player, like YouTube's own.
  if (tooltip.parentElement !== player) player.append(tooltip);
  tooltipText.textContent = audioButtonLabel();

  // Centre it above the button, kept inside the player's edges. Measuring
  // (getBoundingClientRect) only happens here, on hover, never in a loop.
  const playerBox = player.getBoundingClientRect();
  const buttonBox = audioButton.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const margin = 12;
  const centre = buttonBox.left + buttonBox.width / 2 - playerBox.left;
  const left = Math.min(Math.max(centre - width / 2, margin), playerBox.width - width - margin);
  tooltip.style.left = `${Math.round(left)}px`;
  // Vertically, YouTube puts button tooltips just above the progress bar,
  // not just above the button (v2.0.11: ours overlapped the progress bar).
  // So we line up on the top of the progress bar, falling back to the control
  // bar, then to the button itself if the player layout ever changes.
  const anchor =
    player.querySelector(".ytp-progress-bar-container") ??
    player.querySelector(".ytp-chrome-bottom") ??
    audioButton;
  const anchorTop = anchor.getBoundingClientRect().top;
  tooltip.style.top = `${Math.round(anchorTop - playerBox.top - height - 8)}px`;
  tooltip.setAttribute("aria-hidden", "false");
}

function hideTooltip() {
  tooltip?.setAttribute("aria-hidden", "true");
}

async function onAudioButtonClick(event) {
  // The player reacts to clicks on its surface (play/pause...). Keep this
  // click to ourselves.
  event.stopPropagation();
  const turningOn = !audioModeWanted;
  if (turningOn) {
    // Remember your usual quality before forcing 144p. Saved at each switch
    // on, while audio mode is off, so it is always your real preference.
    const usual = playerApi()?.getPreferredQuality?.() || "auto";
    await browser.storage.local.set({ [QUALITY_BEFORE_KEY]: String(usual) });
  }
  // Every YouTube tab (this one included) reacts through storage.onChanged below.
  await browser.storage.local.set({ [AUDIO_MODE_KEY]: turningOn });
}

/* ---------------------------------------------------------------------- */
/* Start                                                                  */
/* ---------------------------------------------------------------------- */

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && AUDIO_MODE_KEY in changes) {
    audioModeWanted = changes[AUDIO_MODE_KEY].newValue === true;
    updateAudioMode();
  }
});

browser.storage.local.get(AUDIO_MODE_KEY).then((stored) => {
  audioModeWanted = stored[AUDIO_MODE_KEY] === true;
  // A page loaded while audio mode is on: YouTube already remembers 144p, so
  // count it as applied; switching off will then restore your quality.
  audioModeApplied = audioModeWanted;
  updateAudioMode();
});
