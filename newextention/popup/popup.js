/*
 * popup/popup.js
 *
 * The normal-mode toolbar popup. Everything here applies at once: in normal
 * mode the guardian accepts any change (background.js). "Hardcore" switches
 * mode immediately (it only makes protection stronger) and opens the
 * settings page, where the friction profile is chosen.
 *
 * Shares the texts of the settings page (options/i18n.js) and its language
 * choice (storage.local "uiLanguage").
 */
"use strict";

const LANG_KEY = "uiLanguage";
let view = null;

const $ = (id) => document.getElementById(id);
const send = (type, data = {}) => browser.runtime.sendMessage({ type, ...data });
const getPath = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);

function render() {
  const on = view.settings.active;
  $("status").textContent = t(on ? "st.active" : "st.off");
  $("toggle").textContent = t(on ? "st.disableNormal" : "st.reactivate");
  for (const input of document.querySelectorAll("input[data-setting]")) {
    input.checked = getPath(view.settings, input.dataset.setting) === true;
  }
}

async function refresh() {
  view = await send("getState");
  render();
}

async function setLanguage(lang, save = true) {
  currentLang = LANGUAGES.includes(lang) ? lang : "en";
  if (save) await browser.storage.local.set({ [LANG_KEY]: currentLang });
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === currentLang));
  }
  translateStatic();
  if (view) render();
}

document.querySelector(".langs").addEventListener("click", (event) => {
  const lang = event.target.closest("[data-lang]")?.dataset.lang;
  if (lang && lang !== currentLang) setLanguage(lang);
});

document.addEventListener("change", async (event) => {
  const path = event.target.dataset?.setting;
  if (!path) return;
  await send("setSettings", { changes: { [path]: event.target.checked } });
  await refresh();
});

$("toggle").addEventListener("click", async () => {
  await send("setSettings", { changes: { active: !view.settings.active } });
  await refresh();
});

// Fix: close the popup only once Firefox has opened (or switched to) the
// settings tab. Closing it right away could cut the call short, and the
// page didn't come to the front.
$("all-settings").addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});

$("to-hardcore").addEventListener("click", async () => {
  await send("chooseMode", { mode: "hardcore" });
  await browser.runtime.openOptionsPage();
  window.close();
});

(async () => {
  const stored = (await browser.storage.local.get(LANG_KEY))[LANG_KEY];
  await setLanguage(stored ?? defaultLanguage(), false);
  await refresh();
  document.body.classList.remove("loading");
})();
