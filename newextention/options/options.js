/*
 * options/options.js
 *
 * The settings page. It never changes protection by itself: it asks the
 * guardian (background.js) through messages, and the guardian decides.
 *
 * Two modes (chosen on the welcome screen):
 *   normal    every change applies at once.
 *   hardcore  checking a protective box (stronger) applies at once;
 *             unchecking one (weaker) is "staged" [~] and must go through a
 *             request: quota and locked-hours check, focus timer, then the
 *             guardian's delay. Going back to normal mode is a request too.
 * Comfort options always apply at once.
 *
 * Display: text mode in full-height columns (options.css). Bars and charts
 * are made of characters. The page is redrawn after every action, when
 * settings change elsewhere, when the language changes, and every 30 s for
 * the countdowns; nothing moves in between. Texts come from i18n.js (t, tn).
 */
"use strict";

const P = DFProtection;
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // displayed Monday first
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TABS = ["etat", "masquages", "friction", "historique"];
const LANG_KEY = "uiLanguage"; // storage.local, this device only

let view = null; // last state received from the guardian
// Weakening changes waiting for a request (hardcore mode only).
let staged = { settings: {}, friction: null, profile: null, mode: null };
let focusRunning = false;
let noticeText = ""; // last focus interruption / refusal, shown in État

const $ = (id) => document.getElementById(id);
const send = (type, data = {}) => browser.runtime.sendMessage({ type, ...data });
const isHardcore = () => view.mode === "hardcore";
const emptyStaged = () => ({ settings: {}, friction: null, profile: null, mode: null });

/* ---------------------------------------------------------------------- */
/* Formatting (in the current language)                                   */
/* ---------------------------------------------------------------------- */

function formatDuration(minutes) {
  if (minutes < 60) return t("u.min", { n: minutes });
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? t("u.hmin", { h, m }) : t("u.h", { n: h });
  }
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  return h ? t("u.dh", { d, h }) : t("u.days", { n: d });
}

const dateLocale = () => DATE_LOCALE[currentLang];

// "jeu. 20 nov. 09:42" / "Thu 20 Nov 09:42" / "11月20日周四 09:42"
const formatDate = (timestamp) =>
  new Date(timestamp).toLocaleString(dateLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

// For the history table.
const formatShortDate = (timestamp) =>
  new Date(timestamp).toLocaleString(dateLocale(), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const formatTime = (timestamp) =>
  new Date(timestamp).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" });

const minutesUntil = (timestamp) => Math.max(0, Math.ceil((timestamp - Date.now()) / 60000));
const dayNames = () => DAY_NAMES_BY_LANG[currentLang];

function describeDays(days) {
  const sorted = [...days].sort().join(",");
  if (sorted === "0,1,2,3,4,5,6") return t("days.all");
  if (sorted === "1,2,3,4,5") return t("days.weekdays");
  if (sorted === "0,6") return t("days.weekend");
  return DAY_ORDER.filter((day) => days.includes(day)).map((day) => dayNames()[day]).join(" ");
}

// Long form for the Friction tab: "tous les jours 22:00–07:00"
function describeLocked(friction) {
  if (!friction.lockedHours.length) return t("fr.none");
  return friction.lockedHours.map((rule) => `${describeDays(rule.days)} ${rule.from}–${rule.to}`).join(" ; ");
}

// Short form for the picker table: "22–07, sem 9–18"
function shortLocked(friction) {
  if (!friction.lockedHours.length) return "—";
  const hour = (time) => (time.endsWith(":00") ? String(Number(time.slice(0, 2))) : time);
  return friction.lockedHours
    .map((rule) => {
      const sorted = [...rule.days].sort().join(",");
      const prefix = sorted === "0,1,2,3,4,5,6" ? "" : sorted === "1,2,3,4,5" ? `${t("days.wkShort")} ` : `${describeDays(rule.days)} `;
      return `${prefix}${hour(rule.from)}–${hour(rule.to)}`;
    })
    .join(", ");
}

const profileLabel = (profile) => t(`prof.${profile in P.PROFILES || profile === "custom" ? profile : "custom"}`);

function labelFor(path) {
  return document.querySelector(`[data-setting="${path}"]`)?.closest("label")?.textContent.trim() ?? path;
}

function describeSettingChange(path, value) {
  if (path === "active") return t(value ? "ch.protOn" : "ch.protOff");
  return t(value ? "ch.on" : "ch.off", { label: labelFor(path) });
}

/* ---------------------------------------------------------------------- */
/* Text graphics                                                          */
/* ---------------------------------------------------------------------- */

// [██████░░░░]
function textBar(fraction, width) {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

// Fills a .bar element: drawing (hidden from screen readers) + value.
function setBar(element, fraction, width, valueText) {
  element.querySelector(".bar-art").textContent = textBar(fraction, width);
  element.querySelector(".bar-value").textContent = valueText;
  element.setAttribute("aria-valuenow", String(Math.round(Math.min(1, fraction) * 100)));
  element.setAttribute("aria-valuetext", valueText);
}

/* ---------------------------------------------------------------------- */
/* Tabs                                                                   */
/* ---------------------------------------------------------------------- */

let currentTab = "etat";

// The active tab is kept in the address (#friction), so reloading the page
// keeps you where you were.
function showTab(name, moveFocus = false) {
  const available = TABS.filter((tab) => !$(`tab-${tab}`).hidden);
  if (!available.includes(name)) name = "etat";
  currentTab = name;
  for (const tab of TABS) {
    const button = $(`tab-${tab}`);
    const selected = tab === name;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`panel-${tab}`).hidden = !selected;
    if (selected && moveFocus) button.focus();
  }
  history.replaceState(null, "", `#${name}`);
}

$("tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]")?.dataset.tab;
  if (tab) showTab(tab);
});

// Arrow keys move between tabs, as expected of a tab list.
$("tabs").addEventListener("keydown", (event) => {
  const tabs = TABS.filter((tab) => !$(`tab-${tab}`).hidden);
  const current = tabs.indexOf(event.target.dataset.tab);
  if (current < 0) return;
  const next = {
    ArrowDown: (current + 1) % tabs.length,
    ArrowRight: (current + 1) % tabs.length,
    ArrowUp: (current - 1 + tabs.length) % tabs.length,
    ArrowLeft: (current - 1 + tabs.length) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  showTab(tabs[next], true);
});

// "Valider dans État" and similar shortcuts.
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-goto]");
  if (target) showTab(target.dataset.goto, true);
});

/* ---------------------------------------------------------------------- */
/* Language                                                               */
/* ---------------------------------------------------------------------- */

async function setLanguage(lang, save = true) {
  currentLang = LANGUAGES.includes(lang) ? lang : "en";
  if (save) await browser.storage.local.set({ [LANG_KEY]: currentLang });
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === currentLang));
  }
  if (view) {
    setupPickers(); // their rows contain formatted values
    translateStatic();
    render();
  } else {
    translateStatic();
  }
}

document.querySelector(".langs").addEventListener("click", (event) => {
  const lang = event.target.closest("[data-lang]")?.dataset.lang;
  if (lang && lang !== currentLang) setLanguage(lang);
});

/* ---------------------------------------------------------------------- */
/* Rendering                                                              */
/* ---------------------------------------------------------------------- */

const stagedMasks = () => Object.keys(staged.settings).filter((path) => path !== "active");
const stagedCount = () =>
  Object.keys(staged.settings).length + (staged.friction ? 1 : 0) + (staged.mode ? 1 : 0);

function displayedValue(path) {
  return path in staged.settings ? staged.settings[path] : P.getPath(view.settings, path) === true;
}

function fillList(list, items) {
  list.replaceChildren(
    ...items.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
}

function requestItems(request) {
  const items = Object.entries(request.settings).map(([path, value]) => describeSettingChange(path, value));
  if (request.friction) items.push(t("sg.friction", { p: profileLabel(request.profile ?? "custom") }));
  if (request.mode) items.push(t("sg.mode"));
  return items;
}

// When protection was last switched off (from the history), if known.
function offSince() {
  const entry = [...view.history].reverse().find((item) => item.settings?.active === false);
  return entry?.appliedAt ?? null;
}

function render() {
  const welcome = view.mode === null;
  const onboarding = !welcome && isHardcore() && view.profile === null;
  $("welcome").hidden = !welcome;
  $("onboarding").hidden = !onboarding;
  $("focus-screen").hidden = !focusRunning || welcome || onboarding;
  const main = !welcome && !onboarding && !focusRunning;
  $("tabs").hidden = !main;
  // Tab panels: only the current one, and only when no other screen is up.
  for (const tab of TABS) $(`panel-${tab}`).hidden = !main || tab !== currentTab;

  // Tabs depending on the mode.
  if (!welcome) {
    $("tab-friction").textContent = t(isHardcore() ? "tab.friction.hardcore" : "tab.friction.normal");
    $("tab-historique").hidden = !isHardcore();
    if ($(`tab-${currentTab}`).hidden) showTab("etat");
  }

  if (main) {
    renderStatus();
    renderStaged();
    renderChecks();
    renderFriction();
    renderHistory();
  }
}

function renderStatus() {
  const off = !view.settings.active;
  const request = view.request;
  const hardcore = isHardcore();

  // The single, biggest status line.
  const hero = $("hero-title");
  hero.textContent = off ? t("st.off") : request ? t("st.pending", { date: formatDate(request.applyAt) }) : t("st.active");
  hero.classList.toggle("alert", off || Boolean(request));

  const since = off ? offSince() : null;
  $("hero-sub").textContent = off
    ? since ? t("st.since", { date: formatDate(since) }) : ""
    : request ? "" : hardcore ? t("st.profile", { p: profileLabel(view.profile) }) : t("st.modeNormal");

  $("reactivate-line").hidden = !off;
  $("disable-line").hidden = off || "active" in staged.settings;
  $("disable").textContent = t(hardcore ? "st.disableHard" : "st.disableNormal");

  // Pending request: countdown bar and what will change.
  $("request-block").hidden = !request;
  if (request) {
    const left = minutesUntil(request.applyAt);
    const when = left > 0 ? t("st.in", { d: formatDuration(left) }) : t("st.due");
    // When the big line already says "Reduction scheduled — date", don't repeat the date.
    $("request-when").textContent = off ? t("st.pendingInline", { date: formatDate(request.applyAt), when }) : when;
    const total = request.applyAt - request.requestedAt;
    const fraction = total > 0 ? (Date.now() - request.requestedAt) / total : 1;
    setBar($("request-bar"), fraction, 20, t("st.ofDelay", { pct: Math.round(Math.min(1, fraction) * 100) }));
    fillList($("request-list"), requestItems(request));
  }

  // Hardcore only: the unlock quota and the latest events (columns 2-3).
  $("col-unlocks").hidden = !hardcore;
  $("col-recent").hidden = !hardcore;
  $("locked-line").hidden = !hardcore || !view.locked;
  if (hardcore) {
    $("locked-line").textContent = view.nextUnlock ? t("st.lockedUntil", { time: formatTime(view.nextUnlock) }) : t("st.locked");
    renderQuota();
    renderRecent();
  }

  $("notice").hidden = !noticeText;
  $("notice").textContent = noticeText;
}

// Unlocks used over the rolling 7 days: a bar with one cell per allowed
// unlock, and one column per day (the quota window) as a small chart:
//   1 │          █
//   0 └─────────────────────
//      l  m  m  j  v  s  d
function renderQuota() {
  const quota = view.friction.weeklyQuota;
  const used = Math.min(view.quotaUsed, quota);
  $("quota-line").textContent = `${textBar(used / quota, quota)} ${t("st.quotaShort", { used: view.quotaUsed, quota })}`;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => midnight.getTime() - (6 - i) * DAY_MS);
  const counts = days.map((start) => view.history.filter((e) => e.appliedAt >= start && e.appliedAt < start + DAY_MS).length);
  const max = Math.max(1, ...counts);
  const lines = [];
  for (let level = max; level >= 1; level--) {
    lines.push(`${String(level).padStart(2)} │ ${counts.map((count) => (count >= level ? "█" : " ")).join("  ")}`);
  }
  lines.push(`   └${"─".repeat(counts.length * 3)}`);
  // Day initials; Chinese ones are double width, so one space less.
  const gap = currentLang === "zh" ? " " : "  ";
  lines.push(`     ${days.map((start) => dayLetter(new Date(start).getDay())).join(gap)}`);
  $("quota-chart").textContent = lines.join("\n");
  $("quota-chart-text").textContent = t("hi.sr", { list: counts.join(", ") });

  $("quota-next").hidden = view.quotaUsed < quota;
  $("quota-next").textContent = t("st.quotaNext", { date: formatDate(view.quotaFreesAt) });
}

const dayLetter = (day) => (currentLang === "zh" ? dayNames()[day].slice(-1) : dayNames()[day].slice(0, 1));

function historyParts(entry) {
  const parts = Object.entries(entry.settings).map(([path, value]) => describeSettingChange(path, value));
  if (entry.friction) parts.push(t("ch.frictionSoft", { p: profileLabel(entry.friction.profile) }));
  if (entry.mode) parts.push(t("sg.mode"));
  return parts;
}

// The 5 latest applied reductions (the full list is in Historique).
function renderRecent() {
  const latest = [...view.history].reverse().slice(0, 5);
  const list = $("recent-list");
  if (!latest.length) {
    fillList(list, [t("hi.empty")]);
    return;
  }
  list.replaceChildren(
    ...latest.map((entry) => {
      const item = document.createElement("li");
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = formatShortDate(entry.appliedAt);
      item.append(when, historyParts(entry).join(" ; "));
      return item;
    }),
  );
}

// Why a request can't be made right now (null if it can). Kept short: the
// details (dates) are already on the status lines above.
function blockedReason() {
  if (view.request) return t("block.pending");
  if (view.locked) return t("block.locked");
  if (view.quotaUsed >= view.friction.weeklyQuota) return t("block.quota");
  return null;
}

function renderStaged() {
  const count = stagedCount();
  const masks = stagedMasks().length;
  $("staged-block").hidden = count === 0;
  $("staged-hint").hidden = masks === 0;
  $("masks-hint").hidden = !isHardcore();
  $("staged-hint-text").textContent = tn("sg.hint", masks);
  if (count === 0) return;

  $("staged-title").textContent = tn("sg.title", count);
  $("staged-rules").textContent = t("sg.rules", { focus: view.friction.focusMin, delay: formatDuration(view.friction.delayMin) });

  // The masks are already marked [~] in their tab; list only what isn't
  // visible elsewhere (protection off, friction, mode) plus a pointer.
  const items = [];
  if (masks) items.push(tn("sg.boxes", masks));
  if ("active" in staged.settings) items.push(describeSettingChange("active", false));
  if (staged.friction) items.push(t("sg.friction", { p: profileLabel(staged.profile ?? "custom") }));
  if (staged.mode) items.push(t("sg.mode"));
  fillList($("staged-list"), items);

  const blocked = blockedReason();
  $("staged-blocked").hidden = !blocked;
  $("staged-blocked").textContent = blocked ?? "";
  $("focus-start").disabled = Boolean(blocked);
  $("focus-start").textContent = t("sg.start", { n: view.friction.focusMin });
}

function renderChecks() {
  for (const input of document.querySelectorAll("input[data-setting]")) {
    const path = input.dataset.setting;
    input.checked = displayedValue(path);
    input.closest("label").classList.toggle("staged", path in staged.settings);
  }
  for (const element of document.querySelectorAll("[data-show-when]")) {
    const [path, expected] = element.dataset.showWhen.split(":");
    element.hidden = String(displayedValue(path)) !== expected;
  }
}

function renderFriction() {
  const hardcore = isHardcore();
  $("fr-normal").hidden = hardcore;
  for (const id of ["fr-current", "fr-change", "fr-mode"]) $(id).hidden = !hardcore;
  $("to-normal").disabled = Boolean(staged.mode);
  if (!hardcore) return;

  $("friction-profile").textContent = t("st.profile", { p: profileLabel(view.profile) });
  const rows = [
    [t("fr.delay"), formatDuration(view.friction.delayMin)],
    [t("fr.focus"), t("u.min", { n: view.friction.focusMin })],
    [t("fr.quota"), String(view.friction.weeklyQuota)],
    [t("fr.locked"), describeLocked(view.friction)],
  ];
  $("friction-values").replaceChildren(
    ...rows.flatMap(([term, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

// Reductions per week over the last 8 weeks, as a column chart:
//   2 │          █
//   1 │  █       █        █
//     └─────────────────────────────────
//      -7  -6  -5  -4  -3  -2  -1  this week
function renderHistory() {
  const now = Date.now();
  const counts = Array(8).fill(0);
  for (const entry of view.history) {
    const weeksAgo = Math.floor((now - entry.appliedAt) / WEEK_MS);
    if (weeksAgo >= 0 && weeksAgo < 8) counts[7 - weeksAgo] += 1;
  }
  const max = Math.max(1, ...counts);
  const lines = [];
  for (let level = max; level >= 1; level--) {
    lines.push(`${String(level).padStart(2)} │ ${counts.map((count) => (count >= level ? "█" : " ")).join("   ")}`);
  }
  lines.push(`   └${"─".repeat(counts.length * 4)}`);
  lines.push(`    -7  -6  -5  -4  -3  -2  -1  ${t("hi.thisWeek")}`);
  $("history-chart").textContent = lines.join("\n");
  $("history-chart-text").textContent = t("hi.sr", { list: counts.join(", ") });

  const history = [...view.history].reverse();
  const rows = history.length
    ? history.map((entry) => {
        return [formatShortDate(entry.appliedAt), historyParts(entry).join(" ; ")];
      })
    : [["—", t("hi.empty")]];
  $("history-rows").replaceChildren(
    ...rows.map(([date, change]) => {
      const tr = document.createElement("tr");
      for (const text of [date, change]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
}

/* ---------------------------------------------------------------------- */
/* State                                                                  */
/* ---------------------------------------------------------------------- */

async function refresh() {
  view = await send("getState");
  // Drop staged entries that no longer make sense (already applied, mode
  // changed, setting turned off by an applied request...).
  if (!isHardcore()) staged = emptyStaged();
  for (const path of Object.keys(staged.settings)) {
    if (P.getPath(view.settings, path) !== true) delete staged.settings[path];
  }
  if (staged.friction && !P.frictionWeakens(view.friction, staged.friction)) {
    staged.friction = null;
    staged.profile = null;
  }
  render();
}

/* ---------------------------------------------------------------------- */
/* Actions                                                                */
/* ---------------------------------------------------------------------- */

async function changeSetting(path, wanted) {
  const current = P.getPath(view.settings, path) === true;
  if (isHardcore() && P.weakens(path, current, wanted)) {
    staged.settings[path] = wanted; // waits for a request
    render();
    return;
  }
  delete staged.settings[path]; // re-checking a staged box simply cancels it
  if (wanted !== current) await send("setSettings", { changes: { [path]: wanted } });
  await refresh();
}

document.addEventListener("change", (event) => {
  const path = event.target.dataset?.setting;
  if (path) changeSetting(path, event.target.checked);
});

$("disable").addEventListener("click", () => {
  noticeText = "";
  changeSetting("active", false);
});

$("reactivate").addEventListener("click", () => changeSetting("active", true));

$("staged-discard").addEventListener("click", () => {
  staged = emptyStaged();
  noticeText = "";
  render();
});

$("request-cancel").addEventListener("click", async () => {
  await send("cancelRequest");
  await refresh();
});

// Welcome screen and the Mode section.
async function chooseMode(mode) {
  const result = await send("chooseMode", { mode });
  if (result.needsRequest) {
    // Hardcore -> normal: staged like any other reduction.
    staged.mode = "normal";
    showTab("etat", true);
  }
  await refresh();
}

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => chooseMode(button.dataset.mode));
}
$("to-hardcore").addEventListener("click", () => chooseMode("hardcore"));
$("to-normal").addEventListener("click", () => chooseMode("normal"));

/* ---------------------------------------------------------------------- */
/* Focus timer                                                            */
/* ---------------------------------------------------------------------- */

// The guardian holds the official start time (see background.js). The page
// shows the countdown, reports every 15 s, and gives up as soon as the tab
// is hidden or the window loses focus. While it runs, the timer is the only
// thing on screen.
let focusStartedAt = 0;
let displayTimer = null;
let tickTimer = null;

function stopFocusTimers() {
  clearInterval(displayTimer);
  clearInterval(tickTimer);
  displayTimer = tickTimer = null;
}

async function startFocus() {
  const result = await send("focusStart");
  focusStartedAt = result.startedAt;
  focusRunning = true;
  noticeText = "";
  displayTimer = setInterval(updateFocusDisplay, 1000);
  tickTimer = setInterval(focusTick, 15000);
  render();
  updateFocusDisplay();
  $("focus-abort").focus();
}

async function focusTick() {
  const result = await send("focusTick");
  if (result.restarted) {
    interruptFocus(t("nt.inactive"));
    return;
  }
  focusStartedAt = result.startedAt;
}

function updateFocusDisplay() {
  const totalMs = view.friction.focusMin * 60000;
  const elapsedMs = Date.now() - focusStartedAt;
  const remainingMs = totalMs - elapsedMs;
  if (remainingMs <= 0) {
    finishFocus();
    return;
  }
  const seconds = Math.ceil(remainingMs / 1000);
  $("focus-time").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const fraction = elapsedMs / totalMs;
  setBar($("focus-bar"), fraction, 30, `${Math.floor(fraction * 100)} %`);
}

async function finishFocus() {
  stopFocusTimers();
  focusRunning = false;
  await send("focusTick"); // a last report, so the guardian sees no gap
  const result = await send("submitRequest", {
    settings: staged.settings,
    friction: staged.friction,
    profile: staged.profile,
    mode: staged.mode,
  });
  if (result.ok) {
    staged = emptyStaged();
    noticeText = "";
  } else {
    noticeText = t(`err.${result.error}`) === `err.${result.error}` ? t("err.refused") : t(`err.${result.error}`);
  }
  showTab("etat");
  await refresh();
}

function interruptFocus(message) {
  if (!focusRunning) return;
  stopFocusTimers();
  focusRunning = false;
  send("focusStop");
  noticeText = message;
  render();
  showTab("etat");
}

$("focus-start").addEventListener("click", startFocus);
$("focus-abort").addEventListener("click", () => interruptFocus(t("nt.abandoned")));

// Leaving the tab, or another window coming in front, resets the timer.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") interruptFocus(t("nt.leftTab"));
});
window.addEventListener("blur", () => interruptFocus(t("nt.blur")));

/* ---------------------------------------------------------------------- */
/* Profile pickers (first time in hardcore, and "change profile")         */
/* ---------------------------------------------------------------------- */

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;
const DELAY_CHOICES = [60, 120, 360, 720, 1440, 2880, 4320, 10080];

// One locked-hours row: [x] lun [x] mar … 22:00 07:00 [ Retirer ]
function createRuleRow(rule) {
  const row = document.createElement("p");
  row.className = "rule-row";
  for (const day of DAY_ORDER) {
    const label = document.createElement("label");
    label.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = String(day);
    box.checked = rule.days.includes(day);
    const art = document.createElement("span");
    art.className = "box";
    label.append(box, art, dayNames()[day]);
    row.append(label);
  }
  for (const [name, value, key] of [["from", rule.from, "pk.from"], ["to", rule.to, "pk.to"]]) {
    const time = document.createElement("input");
    time.type = "time";
    time.step = "900"; // 15-minute steps, the precision of the lock grid
    time.dataset.time = name;
    time.value = value;
    time.setAttribute("aria-label", t(key));
    row.append(time);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn quiet";
  remove.textContent = t("pk.remove");
  remove.addEventListener("click", () => row.remove());
  row.append(remove);
  return row;
}

// One profile row: (•) Équilibré  12 h  3  —   (focus is 20 min in every
// preset, so it only appears in the custom form and the spoken sentence)
function createProfileRow(name, key, friction, checked) {
  const row = document.createElement("label");
  row.className = "picker-row choice";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = name;
  radio.value = key;
  radio.checked = checked;
  row.append(radio);

  const label = profileLabel(key);
  const cells = friction
    ? [label, formatDuration(friction.delayMin), String(friction.weeklyQuota), shortLocked(friction)]
    : [label, "", "", ""];
  cells.forEach((text, index) => {
    const cell = document.createElement("span");
    cell.textContent = text;
    if (index === 0) cell.className = "name";
    else cell.setAttribute("aria-hidden", "true");
    row.append(cell);
  });
  // Screen readers get the values as a sentence instead of loose cells.
  if (friction) {
    const sentence = document.createElement("span");
    sentence.className = "sr-only";
    sentence.textContent = t("pk.sentence", {
      delay: formatDuration(friction.delayMin),
      focus: friction.focusMin,
      quota: friction.weeklyQuota,
      locked: describeLocked(friction),
    });
    row.append(sentence);
  }
  return row;
}

// Builds a picker inside `container` (replacing any previous one); returns a
// function giving the current choice.
function buildPicker(container, initialProfile, initialFriction) {
  container.replaceChildren($("picker-template").content.cloneNode(true));
  const name = nextId("profile");
  const rowsBox = container.querySelector(".picker-rows");
  const custom = container.querySelector(".custom");

  for (const [key, profile] of Object.entries(P.PROFILES)) {
    rowsBox.append(createProfileRow(name, key, profile.friction, key === initialProfile));
  }
  rowsBox.append(createProfileRow(name, "custom", null, initialProfile === "custom"));

  // Custom form, starting from the current values. Labels get unique ids.
  for (const field of custom.querySelectorAll(".field")) {
    const control = field.querySelector("[data-field]");
    control.id = nextId("field");
    field.querySelector("label").htmlFor = control.id;
  }
  const field = (key) => custom.querySelector(`[data-field="${key}"]`);
  for (const minutes of DELAY_CHOICES) {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent = formatDuration(minutes);
    field("delayMin").append(option);
  }
  field("delayMin").value = String(initialFriction.delayMin);
  if (!field("delayMin").value) field("delayMin").value = "720";
  field("focusMin").value = String(initialFriction.focusMin);
  field("weeklyQuota").value = String(initialFriction.weeklyQuota);
  const rules = custom.querySelector(".locked-rules");
  for (const rule of initialFriction.lockedHours) rules.append(createRuleRow(rule));
  custom.querySelector(".add-rule").addEventListener("click", () => {
    rules.append(createRuleRow({ days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" }));
  });

  const selected = () => container.querySelector(`input[name="${name}"]:checked`)?.value ?? "balanced";
  rowsBox.addEventListener("change", () => {
    custom.hidden = selected() !== "custom";
  });
  custom.hidden = selected() !== "custom";

  return () => {
    const profile = selected();
    if (profile !== "custom") return { profile, friction: null };
    return {
      profile,
      friction: {
        delayMin: Number(field("delayMin").value),
        focusMin: Number(field("focusMin").value),
        weeklyQuota: Number(field("weeklyQuota").value),
        lockedHours: [...rules.querySelectorAll(".rule-row")].map((row) => ({
          days: [...row.querySelectorAll('input[type="checkbox"]:checked')].map((box) => Number(box.value)),
          from: row.querySelector('[data-time="from"]').value,
          to: row.querySelector('[data-time="to"]').value,
        })),
      },
    };
  };
}

const profileError = (code) => t(code === "whole-week-locked" ? "err.whole-week" : "err.choice");

// Built at start and rebuilt when the language changes (they contain
// formatted values). The buttons below always use the latest picker.
let onboardingChoice = null;
let changeChoice = null;

function setupPickers() {
  onboardingChoice = buildPicker(document.querySelector('[data-picker="onboarding"]'), "balanced", view.friction);
  changeChoice = buildPicker(
    document.querySelector('[data-picker="change"]'),
    view.profile ?? "balanced",
    view.friction,
  );
}

$("onboarding-confirm").addEventListener("click", async () => {
  const result = await send("chooseProfile", onboardingChoice());
  $("onboarding-error").hidden = result.ok;
  $("onboarding-error").textContent = result.ok ? "" : profileError(result.error);
  await refresh();
});

$("friction-apply").addEventListener("click", async () => {
  const choice = changeChoice();
  const result = await send("chooseProfile", choice);
  $("friction-error").hidden = true;
  if (result.ok) {
    $("friction-change").open = false;
  } else if (result.needsRequest) {
    // Softer friction: staged like any other reduction, validated in État.
    staged.friction = result.friction;
    staged.profile = choice.profile;
    $("friction-change").open = false;
    showTab("etat", true);
  } else {
    $("friction-error").hidden = false;
    $("friction-error").textContent = profileError(result.error);
  }
  await refresh();
});

/* ---------------------------------------------------------------------- */
/* Start                                                                  */
/* ---------------------------------------------------------------------- */

// Settings or protection state changed elsewhere (the guardian applying a
// request, another tab of this page...): show it.
browser.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" && "dfYoutubeOptions" in changes) || (area === "local" && P.STORAGE_KEY in changes)) {
    refresh();
  }
});


(async () => {
  const stored = (await browser.storage.local.get(LANG_KEY))[LANG_KEY];
  await setLanguage(stored ?? defaultLanguage(), false);
  // The static texture: plain text generated once by tools/make_ascii_moai.py.
  fetch(browser.runtime.getURL("options/moai.txt"))
    .then((response) => response.text())
    .then((text) => ($("texture").textContent = text))
    .catch(() => {}); // decoration only
  $("private-warning").hidden = await browser.extension.isAllowedIncognitoAccess();
  view = await send("getState");
  setupPickers();
  translateStatic(); // the pickers' static texts come from the template
  showTab(location.hash.slice(1));
  await refresh();
  document.body.classList.remove("loading");
  // Keeps the countdowns and quota up to date.
  setInterval(() => {
    if (!focusRunning) refresh();
  }, 30000);
})();
