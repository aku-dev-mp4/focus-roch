/*
 * content/transcript.js
 *
 * Setting `transcriptButtons` adds two small round buttons:
 *   - "Transcript", right after Like / Dislike: opens (or closes) YouTube's
 *     transcript, which is otherwise hidden at the bottom of the expanded
 *     description. It simply clicks YouTube's own "Show transcript" button.
 *   - "Copy transcript", in the header of the side panel that shows the
 *     transcript, next to its title: copies the whole text.
 *
 * YouTube currently has two transcript UIs, depending on the account:
 *   - old: a panel of its own, segments are <ytd-transcript-segment-renderer>;
 *   - new (2025+): an "In this video" panel with Timeline / Chapters /
 *     Transcript tabs; segments are <transcript-segment-view-model>, grouped
 *     under <timeline-chapter-view-model> chapters with an <h3> title.
 * (Element names read from YouTube's code, Nov 2026.) We don't rely on the
 * panel's id: the copy button goes in whichever side panel contains
 * transcript segments, so both UIs work.
 *
 * v2.0.8: we read the text from the page ourselves instead of triggering
 * YouTube's internal copy action, which only exists in the old UI. The copy
 * is plain text without timestamps: chapter titles on their own line, each
 * chapter's text as one paragraph.
 *
 * Loaded before youtube.js (see manifest.json) and called from it on each
 * navigation and page data update; it uses isOn() defined there.
 */
"use strict";

const PANEL = "ytd-engagement-panel-section-list-renderer";
const OPEN_PANEL = `${PANEL}[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]`;
const SEGMENT = "transcript-segment-view-model, ytd-transcript-segment-renderer";
const TRANSCRIPT_OPEN_BUTTON =
  "ytd-video-description-transcript-section-renderer #primary-button button";
const LIKE_BUTTONS = "ytd-watch-metadata segmented-like-dislike-button-view-model";

// 24x24 icon outlines in the Material Icons style (Apache 2.0).
const ICON_PATHS = {
  transcript: "M4 5h16v2H4zm0 4h16v2H4zm0 4h10v2H4zm0 4h10v2H4z",
  copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
  done: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  failed: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
};

// Button labels in the language of YouTube's interface (<html lang>),
// English otherwise. Read when the buttons are created.
const TRANSCRIPT_LABELS = {
  en: { open: "Transcript", copy: "Copy transcript" },
  fr: { open: "Transcription", copy: "Copier la transcription" },
  zh: { open: "文字记录", copy: "复制文字记录" },
};
const transcriptLabel = (key) =>
  (TRANSCRIPT_LABELS[document.documentElement.lang?.slice(0, 2)] ?? TRANSCRIPT_LABELS.en)[key];

// Created once, then moved back into place whenever YouTube rebuilds the area.
let transcriptButton = null;
let copyButton = null;
let copyFeedbackTimer = null;

/* ---------------------------------------------------------------------- */
/* "Transcript" button, after Like / Dislike                              */
/* ---------------------------------------------------------------------- */

// Called on each navigation and page data update (from youtube.js).
function updateTranscriptButtons() {
  const enabled = isOn("transcriptButtons") && location.pathname === "/watch";
  // Not every video has a transcript: without YouTube's "Show transcript"
  // button there is nothing to open.
  const hasTranscript = enabled && Boolean(document.querySelector(TRANSCRIPT_OPEN_BUTTON));
  const likeButtons = hasTranscript ? document.querySelector(LIKE_BUTTONS) : null;

  if (likeButtons) {
    transcriptButton ??= makeIconButton(transcriptLabel("open"), ICON_PATHS.transcript, onTranscriptClick);
    transcriptButton.id = "dfyt-transcript-button";
    // YouTube may rebuild the Like buttons between videos; re-attach after them.
    if (transcriptButton.previousElementSibling !== likeButtons) likeButtons.after(transcriptButton);
  } else {
    transcriptButton?.remove();
  }

  watchPanels(enabled);
}

function onTranscriptClick() {
  const panel = transcriptPanel();
  if (panel?.matches(OPEN_PANEL)) {
    // The panel's own close (X) button.
    panel.querySelector("#visibility-button button")?.click();
  } else {
    document.querySelector(TRANSCRIPT_OPEN_BUTTON)?.click();
  }
}

// The side panel currently holding transcript segments, if any.
function transcriptPanel() {
  return document.querySelector(SEGMENT)?.closest(PANEL) ?? null;
}

/* ---------------------------------------------------------------------- */
/* "Copy transcript" button, in the transcript panel's header             */
/* ---------------------------------------------------------------------- */

// The transcript text only arrives once you open the panel (and, in the new
// UI, pick its Transcript tab), so we must notice when segments appear.
// Two observers, both narrow:
//   1. On <ytd-watch-flexy>, only the `visibility` attribute, which YouTube
//      sets on a side panel when it opens or closes. Nothing else triggers it.
//   2. While a panel is open: its own content (childList only), to catch the
//      segments arriving or a tab switch. Disconnected when the panel closes.
// Highlighting the current line during playback changes classes, not the
// list of elements, so it doesn't wake observer 2 up.
let panelsObserver = null;
let watchedPage = null;
let openPanelObserver = null;
let observedPanel = null;

// v2.0.12: called many times while a page loads (see settlePage in
// youtube.js), so the observer is only recreated when the watch page element
// itself changes, not on every call.
function watchPanels(enabled) {
  const watchPage = enabled ? document.querySelector("ytd-watch-flexy") : null;
  if (watchPage !== watchedPage) {
    panelsObserver?.disconnect();
    panelsObserver = null;
    watchedPage = watchPage;
    if (watchPage) {
      panelsObserver = new MutationObserver(onPanelVisibilityChange);
      panelsObserver.observe(watchPage, {
        subtree: true,
        attributes: true,
        attributeFilter: ["visibility"],
      });
    }
  }
  if (!watchPage) {
    watchOpenPanel(null);
    copyButton?.remove();
    return;
  }
  onPanelVisibilityChange();
}

function onPanelVisibilityChange() {
  // Only one side panel is open at a time on YouTube's watch page.
  watchOpenPanel(document.querySelector(`ytd-watch-flexy ${OPEN_PANEL}`));
}

function watchOpenPanel(panel) {
  if (panel !== observedPanel) {
    openPanelObserver?.disconnect();
    openPanelObserver = null;
    observedPanel = panel;
    if (panel) {
      openPanelObserver = new MutationObserver(placeCopyButton);
      openPanelObserver.observe(panel, { childList: true, subtree: true });
    }
  }
  placeCopyButton();
}

function placeCopyButton() {
  const hasSegments = observedPanel?.querySelector(SEGMENT);
  // In the panel header, right after the title block ("In this video" /
  // "Transcript"), so it sits next to the title.
  const titleBlock = hasSegments
    ? observedPanel.querySelector("ytd-engagement-panel-title-header-renderer #title-container")
    : null;
  if (!titleBlock) {
    copyButton?.remove();
    return;
  }
  copyButton ??= makeIconButton(transcriptLabel("copy"), ICON_PATHS.copy, onCopyClick);
  copyButton.id = "dfyt-copy-transcript-button";
  if (titleBlock.nextElementSibling !== copyButton) titleBlock.after(copyButton);
}

/* ---------------------------------------------------------------------- */
/* Reading and copying the text                                           */
/* ---------------------------------------------------------------------- */

// A segment's own text, without its timestamp. In the new UI the timestamp
// lives in elements whose class contains "Timestamp" (one visible, one for
// screen readers); in the old UI the text is in `.segment-text`.
function segmentText(segment) {
  if (segment.localName === "ytd-transcript-segment-renderer") {
    return segment.querySelector(".segment-text")?.textContent ?? "";
  }
  return Array.from(segment.children)
    .filter((child) => !String(child.className).includes("Timestamp"))
    .map((child) => child.textContent)
    .join(" ");
}

// Plain text: "Chapter title" on its own line, then that chapter's segments
// joined as one paragraph. Segments are sentence fragments, so joining them
// with spaces reads naturally. Whitespace is tidied up.
function transcriptText(panel) {
  const tidy = (text) => text.replace(/\s+/g, " ").trim();
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push(paragraph.join(" "));
    paragraph = [];
  };

  for (const node of panel.querySelectorAll(`timeline-chapter-view-model > h3, ${SEGMENT}`)) {
    if (node.localName === "h3") {
      flush();
      blocks.push(tidy(node.textContent));
    } else {
      const text = tidy(segmentText(node));
      if (text) paragraph.push(text);
    }
  }
  flush();
  return blocks.join("\n\n");
}

async function onCopyClick() {
  const text = observedPanel ? transcriptText(observedPanel) : "";
  try {
    if (!text) throw new Error("No transcript text found");
    // Allowed because it runs inside your click; the `clipboardWrite`
    // permission (manifest.json) makes it reliable even so.
    await navigator.clipboard.writeText(text);
    showCopyFeedback(ICON_PATHS.done);
  } catch (error) {
    console.error("Focus roc'h: could not copy the transcript.", error);
    showCopyFeedback(ICON_PATHS.failed);
  }
}

function showCopyFeedback(iconPath) {
  const path = copyButton?.querySelector("path");
  path?.setAttribute("d", iconPath);
  clearTimeout(copyFeedbackTimer);
  copyFeedbackTimer = setTimeout(() => path?.setAttribute("d", ICON_PATHS.copy), 1500);
}

/* ---------------------------------------------------------------------- */
/* Shared helper                                                          */
/* ---------------------------------------------------------------------- */

// Built with DOM methods rather than innerHTML: no HTML parsing of strings,
// which is also what Mozilla's add-on review asks for.
function makeIconButton(label, pathData, onClick) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  svg.append(path);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "dfyt-icon-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(svg);
  button.addEventListener("click", onClick);
  return button;
}
