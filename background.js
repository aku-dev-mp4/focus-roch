/*
 * background.js - the "guardian"
 *
 * Two modes, chosen on the welcome screen after installation:
 *   - "normal"   : every change applies at once, like the original extension;
 *                  the toolbar button opens the settings.
 *   - "hardcore" : the friction system below. Going back to normal mode is
 *                  itself a reduction, so it needs a request too.
 *
 * In hardcore mode this is the only part allowed to WEAKEN protection. It:
 *   1. keeps a reference copy of the protective settings (the "baseline");
 *   2. puts back any weakening that didn't go through a request (whether it
 *      came from the developer console, from Firefox Sync, or from a bug),
 *      and accepts any strengthening at once;
 *   3. receives requests from the options page, checks the locked hours,
 *      the weekly quota and the focus timer, then applies each request when
 *      its delay is over;
 *   4. shows the state on the toolbar button (icon + countdown badge). The
 *      button has no popup and does nothing when clicked: the settings are
 *      only reachable from about:addons -> Focus roc'h -> Options.
 *
 * Storage:
 *   storage.sync   dfYoutubeOptions   the settings, read by the content
 *                                     scripts (unchanged)
 *   storage.local  dfytProtection     profile, friction, baseline, pending
 *                                     request, history (this device only,
 *                                     so another machine can't relax it)
 *   storage.session dfytFocus         the focus timer in progress
 *
 * This is an event page: Firefox may unload it when idle. All listeners are
 * registered at the top level so Firefox can wake it up for them, and a
 * one-minute alarm acts as a safety net in case a storage change arrives
 * while it is asleep.
 */
"use strict";

const GUARD_ALARM = "dfyt-guard";
const APPLY_ALARM = "dfyt-apply";
const FOCUS_KEY = "dfytFocus";
// The options page reports every 15 s while the focus timer runs. A longer
// silence means the tab was closed or hidden: the timer restarts from zero.
const FOCUS_MAX_GAP_MS = 45 * 1000;
const HISTORY_LIMIT = 100;
const OPTIONS_URL = browser.runtime.getURL("options/");
const POPUP_URL = browser.runtime.getURL("popup/");

/* ---------------------------------------------------------------------- */
/* One operation at a time                                                */
/* ---------------------------------------------------------------------- */

// Every operation reads the state, changes it and writes it back. Two
// running at once (say, an alarm and a message) could overwrite each other's
// writes, so they are chained: each one starts when the previous is done.
let queue = Promise.resolve();
function serialized(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/* ---------------------------------------------------------------------- */
/* State                                                                  */
/* ---------------------------------------------------------------------- */

async function loadState(settings) {
  const stored = (await browser.storage.local.get(DFProtection.STORAGE_KEY))[DFProtection.STORAGE_KEY];
  if (stored) {
    stored.friction = DFProtection.normalizeFriction(stored.friction);
    stored.history ??= [];
    stored.request ??= null;
    // v2.3: `mode` added. Installs from before it that already chose a
    // friction profile were using the friction system: keep them hardcore.
    if (stored.mode === undefined) stored.mode = stored.profile !== null ? "hardcore" : null;
    return stored;
  }
  // First run (new install, or update from a version without friction).
  // Current settings become the baseline, so nothing you configured is lost.
  // `mode: null` makes the options page show the welcome screen; in hardcore
  // mode, `profile: null` then shows the profile choice (until then the
  // "balanced" values apply).
  return {
    mode: null,
    profile: null,
    friction: DFProtection.normalizeFriction(DFProtection.PROFILES.balanced.friction),
    baseline: DFProtection.snapshot(settings),
    request: null,
    history: [],
  };
}

const saveState = (state) => browser.storage.local.set({ [DFProtection.STORAGE_KEY]: state });

/* ---------------------------------------------------------------------- */
/* Guarding                                                               */
/* ---------------------------------------------------------------------- */

// Compares the live settings with the baseline. Weaker -> put back.
// Stronger -> becomes the new baseline (strengthening is always instant).
async function guard() {
  const settings = await DFSettings.load();
  const state = await loadState(settings);

  // Not hardcore: nothing to protect against, whatever you set is the
  // reference (so switching to hardcore later protects exactly that).
  if (state.mode !== "hardcore") {
    state.baseline = DFProtection.snapshot(settings);
    await saveState(state);
    await showStatus(state, settings);
    return;
  }

  let settingsChanged = false;
  for (const path of DFProtection.PROTECTIVE_PATHS) {
    const live = DFProtection.getPath(settings, path) === true;
    const reference = state.baseline[path] === true;
    if (reference && !live) {
      DFProtection.setPath(settings, path, true);
      settingsChanged = true;
    } else if (live && !reference) {
      state.baseline[path] = true;
    }
  }

  if (settingsChanged) await DFSettings.save(settings);
  await applyDueRequest(state, settings);
  await saveState(state);
  await showStatus(state, settings);
}

// Applies the pending request if its time has come.
async function applyDueRequest(state, settings) {
  const request = state.request;
  if (!request || Date.now() < request.applyAt) return;

  // Locked hours mean "nothing changes now", including requests coming due:
  // it is postponed to the end of the locked period.
  if (DFProtection.isLocked(state.friction)) {
    const unlock = DFProtection.nextUnlock(state.friction);
    if (unlock) {
      request.applyAt = unlock.getTime();
      scheduleApply(request);
    }
    return;
  }

  for (const [path, value] of Object.entries(request.settings)) {
    DFProtection.setPath(settings, path, value);
    if (DFProtection.isProtective(path)) state.baseline[path] = value === true;
  }
  if (Object.keys(request.settings).length > 0) await DFSettings.save(settings);
  if (request.friction) {
    state.friction = request.friction;
    state.profile = request.profile ?? "custom";
  }
  if (request.mode) state.mode = request.mode;

  state.history.push({
    appliedAt: Date.now(),
    requestedAt: request.requestedAt,
    settings: request.settings,
    friction: request.friction ? { profile: request.profile ?? "custom" } : null,
    mode: request.mode ?? null,
  });
  state.history = state.history.slice(-HISTORY_LIMIT);
  state.request = null;
  browser.alarms.clear(APPLY_ALARM);
}

function scheduleApply(request) {
  browser.alarms.create(APPLY_ALARM, { when: request.applyAt });
}

/* ---------------------------------------------------------------------- */
/* Toolbar button: icon + badge                                           */
/* ---------------------------------------------------------------------- */

// Badge: time left before a pending request applies ("11h", "45m", "2j").
function badgeText(state) {
  if (!state.request) return "";
  const minutes = Math.max(0, Math.ceil((state.request.applyAt - Date.now()) / 60000));
  if (minutes >= 48 * 60) return `${Math.floor(minutes / 1440)}j`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}

async function showStatus(state, settings) {
  await DFSettings.setToolbarIcon(settings.active);
  await browser.action.setBadgeText({ text: badgeText(state) });
  await browser.action.setBadgeBackgroundColor({ color: "#d22c2c" });
  // Normal mode: the button opens the quick popup. Hardcore (and before a
  // mode is chosen): no popup. Not declared in manifest.json on purpose,
  // otherwise it would be usable for a moment at startup in hardcore mode.
  await browser.action.setPopup({ popup: state.mode === "normal" ? "/popup/popup.html" : "" });
  // Tooltip in the browser's language (_locales). In hardcore mode the button
  // doesn't open anything, so it says where the settings are.
  await browser.action.setTitle({
    title: browser.i18n.getMessage(state.mode === "hardcore" ? "actionTitleHardcore" : "actionTitleNormal"),
  });
}

// No mode chosen yet: the toolbar button opens the settings (welcome
// screen). Hardcore: it does nothing, the settings are only in about:addons.
// (onClicked only fires when the button has no popup, i.e. not in normal mode.)
browser.action.onClicked.addListener(async () => {
  const state = await loadState(await DFSettings.load());
  if (state.mode !== "hardcore") browser.runtime.openOptionsPage();
});

/* ---------------------------------------------------------------------- */
/* Messages from the options page                                         */
/* ---------------------------------------------------------------------- */

// Builds what the options page displays.
async function describeState() {
  const settings = await DFSettings.load();
  const state = await loadState(settings);
  const focus = (await browser.storage.session.get(FOCUS_KEY))[FOCUS_KEY] ?? null;
  const unlock = DFProtection.nextUnlock(state.friction);
  return {
    now: Date.now(),
    settings,
    mode: state.mode,
    profile: state.profile,
    friction: state.friction,
    request: state.request,
    history: state.history,
    quotaUsed: DFProtection.quotaUsed(state.history),
    quotaFreesAt: DFProtection.quotaFreesAt(state.history),
    locked: DFProtection.isLocked(state.friction),
    nextUnlock: unlock ? unlock.getTime() : null,
    focus,
  };
}

// Instant changes: comfort options and anything that strengthens protection.
// A weakening sent here is refused; it must go through submitRequest.
async function setSettings({ changes }) {
  const settings = await DFSettings.load();
  const state = await loadState(settings);
  const hardcore = state.mode === "hardcore";
  for (const [path, value] of Object.entries(changes)) {
    if (hardcore && DFProtection.weakens(path, DFProtection.getPath(settings, path) === true, value)) {
      return { ok: false, error: "weakening-needs-request" };
    }
  }
  for (const [path, value] of Object.entries(changes)) {
    DFProtection.setPath(settings, path, value);
    if (DFProtection.isProtective(path) && (value === true || !hardcore)) state.baseline[path] = value === true;
  }
  await saveState(state); // baseline first, so the guard never sees a gap
  await DFSettings.save(settings);
  await showStatus(state, settings);
  return { ok: true };
}

// Choosing the mode. First choice, or normal -> hardcore (stronger): at once.
// Hardcore -> normal is a reduction: the page stages it as a request.
async function chooseMode({ mode }) {
  if (mode !== "normal" && mode !== "hardcore") return { ok: false, error: "unknown-mode" };
  const settings = await DFSettings.load();
  const state = await loadState(settings);
  if (state.mode === "hardcore" && mode === "normal") return { ok: false, needsRequest: true };
  if (mode === "hardcore" && state.mode !== "hardcore") {
    // From now on, what is hidden right now is protected.
    state.baseline = DFProtection.snapshot(settings);
  }
  state.mode = mode;
  await saveState(state);
  await showStatus(state, settings);
  return { ok: true };
}

// Choosing a profile (or custom values). Instant the very first time, or if
// the new friction is at least as strong; otherwise it needs a request.
async function chooseProfile({ profile, friction }) {
  if (profile !== "custom" && !(profile in DFProtection.PROFILES)) return { ok: false, error: "unknown-profile" };
  const settings = await DFSettings.load();
  const state = await loadState(settings);
  const next = DFProtection.normalizeFriction(
    profile === "custom" ? friction : DFProtection.PROFILES[profile]?.friction,
  );
  if (DFProtection.coversWholeWeek(next.lockedHours)) return { ok: false, error: "whole-week-locked" };

  // Softer friction needs a request, but only once hardcore with a profile.
  if (state.mode === "hardcore" && state.profile !== null && DFProtection.frictionWeakens(state.friction, next)) {
    return { ok: false, needsRequest: true, friction: next };
  }
  state.profile = profile;
  state.friction = next;
  await saveState(state);
  return { ok: true };
}

/*
 * The focus timer. The countdown is displayed by the options page, but the
 * background keeps the official start time: the page sends a "tick" every
 * 15 s while it stays visible and in front. If ticks stop (tab closed,
 * hidden, another window in front), the next tick finds a gap and the timer
 * restarts. So you can't start it, leave, and come back 20 minutes later.
 * storage.session survives this event page being unloaded, and is cleared
 * when Firefox closes.
 */
async function focusStart() {
  const now = Date.now();
  await browser.storage.session.set({ [FOCUS_KEY]: { startedAt: now, lastTick: now } });
  return { ok: true, startedAt: now };
}

async function focusTick() {
  const now = Date.now();
  const focus = (await browser.storage.session.get(FOCUS_KEY))[FOCUS_KEY];
  const restarted = !focus || now - focus.lastTick > FOCUS_MAX_GAP_MS;
  const next = { startedAt: restarted ? now : focus.startedAt, lastTick: now };
  await browser.storage.session.set({ [FOCUS_KEY]: next });
  return { ok: true, startedAt: next.startedAt, restarted };
}

async function focusStop() {
  await browser.storage.session.remove(FOCUS_KEY);
  return { ok: true };
}

// A weakening request. Every check happens here, not just in the page.
async function submitRequest({ settings: wanted = {}, friction = null, profile = null, mode = null }) {
  const now = Date.now();
  const settings = await DFSettings.load();
  const state = await loadState(settings);

  if (state.mode !== "hardcore") return { ok: false, error: "not-hardcore" };
  if (state.request) return { ok: false, error: "already-pending" };
  if (DFProtection.isLocked(state.friction)) return { ok: false, error: "locked" };
  if (DFProtection.quotaUsed(state.history, now) >= state.friction.weeklyQuota) {
    return { ok: false, error: "quota" };
  }

  const focus = (await browser.storage.session.get(FOCUS_KEY))[FOCUS_KEY];
  const focusDone =
    focus &&
    now - focus.lastTick <= FOCUS_MAX_GAP_MS &&
    now - focus.startedAt >= state.friction.focusMin * 60 * 1000;
  if (!focusDone) return { ok: false, error: "focus" };

  // Keep only what actually weakens protection (the rest is applied
  // instantly by the page through setSettings).
  const weakening = {};
  for (const [path, value] of Object.entries(wanted)) {
    if (DFProtection.weakens(path, DFProtection.getPath(settings, path) === true, value)) {
      weakening[path] = value;
    }
  }
  const nextFriction = friction ? DFProtection.normalizeFriction(friction) : null;
  const frictionChange =
    nextFriction && DFProtection.frictionWeakens(state.friction, nextFriction) ? nextFriction : null;
  const modeChange = mode === "normal" ? "normal" : null;
  if (Object.keys(weakening).length === 0 && !frictionChange && !modeChange) return { ok: false, error: "nothing" };

  // The delay is the one in force NOW: a request to shorten the delay still
  // waits the current, longer one.
  state.request = {
    settings: weakening,
    friction: frictionChange,
    profile: frictionChange ? profile : null,
    mode: modeChange,
    requestedAt: now,
    applyAt: now + state.friction.delayMin * 60 * 1000,
  };
  await saveState(state);
  await browser.storage.session.remove(FOCUS_KEY);
  scheduleApply(state.request);
  await showStatus(state, settings);
  return { ok: true };
}

// Cancelling is always allowed and instant.
async function cancelRequest() {
  const settings = await DFSettings.load();
  const state = await loadState(settings);
  state.request = null;
  await saveState(state);
  await browser.alarms.clear(APPLY_ALARM);
  await showStatus(state, settings);
  return { ok: true };
}

const HANDLERS = {
  getState: describeState,
  setSettings,
  chooseMode,
  chooseProfile,
  focusStart,
  focusTick,
  focusStop,
  submitRequest,
  cancelRequest,
};

browser.runtime.onMessage.addListener((message, sender) => {
  // Only the options page and the popup may talk to the guardian. Content
  // scripts run in YouTube's tabs and have no business changing protection.
  // (The popup only exists in normal mode, where changes are free anyway;
  // in hardcore mode the guardian refuses weakening from anyone.)
  const fromUs = sender.id === browser.runtime.id && (sender.url?.startsWith(OPTIONS_URL) || sender.url?.startsWith(POPUP_URL));
  if (!fromUs) return undefined;
  const handler = HANDLERS[message?.type];
  if (!handler) return undefined;
  // Returning a promise sends its result back as the reply.
  return serialized(() => handler(message));
});

/* ---------------------------------------------------------------------- */
/* Events that wake the guardian                                          */
/* ---------------------------------------------------------------------- */

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && "dfYoutubeOptions" in changes) serialized(guard);
});

browser.alarms.onAlarm.addListener(() => serialized(guard));

async function onBrowserStartOrInstall(details) {
  await serialized(guard);
  const settings = await DFSettings.load();
  const state = await loadState(settings);
  if (state.request) scheduleApply(state.request); // alarms may not survive restarts
  // New install: welcome screen (mode choice); hardcore without a profile
  // yet: profile choice.
  const needsChoice = state.mode === null || (state.mode === "hardcore" && state.profile === null);
  if (needsChoice && details?.reason !== "browser_update") {
    browser.runtime.openOptionsPage();
  }
}

browser.runtime.onStartup.addListener(() => onBrowserStartOrInstall());
browser.runtime.onInstalled.addListener(onBrowserStartOrInstall);

// The safety net: every minute, check the settings and the pending request
// (and refresh the badge countdown). Created each time this page starts;
// re-creating an alarm with the same name simply replaces it.
browser.alarms.create(GUARD_ALARM, { periodInMinutes: 1 });
