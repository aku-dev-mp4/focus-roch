/*
 * shared/settings.js
 *
 * The one place that knows what the settings look like and where they are
 * stored. It is loaded by all three parts of the extension (background,
 * content script, options page), which is why it exposes a single global object
 * instead of using `import`: content scripts declared in manifest.json cannot
 * be ES modules, but scripts listed together share one global scope.
 *
 * Storage is also how the parts talk to each other: the background saves, and
 * every YouTube tab hears about it through `storage.onChanged`. There are no
 * runtime messages, except between the options page and the background.
 */
"use strict";

const DFSettings = (() => {
  // Same key and same shape as DF YouTube, the extension this one was
  // rewritten from. Note: storage.sync data is tied to the add-on ID, and
  // Focus roc'h 1.0 has its own ID (focus-roch@aku-dev-mp4), so settings
  // from the old extension are not carried over.
  const STORAGE_KEY = "dfYoutubeOptions";

  const DEFAULTS = {
    active: true,
    disableAutoplay: true,
    disablePlaylists: false,
    // v2.0.5, new key. Old saved settings don't have it, so withDefaults()
    // fills in `true` for them too.
    lightChat: true,
    transcriptButtons: true, // v2.0.6, new key (same as above)
    audioModeButton: true, // v2.0.9, new key (same as above)
    visibility: {
      hideNotificationBell: false,
      hideRecommended: false, // now means "hide Shorts & topic shelves on Home"
      hideFeed: false,
      hideSidebar: true,
      hideSubBar: false,
      hideRelated: true,
      hideComments: false,
      hidePlaylist: false,
      hideLiveChat: false,
      hideTrending: false,
      hideMerch: false,
      hideNonLists: false,
    },
  };

  const isPlainObject = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  /*
   * Returns a fresh object: the stored values, with defaults filled in for
   * anything missing or of the wrong type.
   *
   * Unlike the old `align_objects`, keys we don't know about (the old
   * `alert` and `applyInstantly`) are kept rather than deleted, so going back
   * to version 1.x still finds its data.
   */
  function withDefaults(defaults, stored) {
    const source = isPlainObject(stored) ? stored : {};
    const result = { ...source };
    for (const [key, fallback] of Object.entries(defaults)) {
      if (isPlainObject(fallback)) {
        result[key] = withDefaults(fallback, source[key]);
      } else if (typeof source[key] !== typeof fallback) {
        result[key] = fallback;
      }
    }
    return result;
  }

  async function load() {
    const data = await browser.storage.sync.get(STORAGE_KEY);
    return withDefaults(DEFAULTS, data[STORAGE_KEY]);
  }

  function save(settings) {
    return browser.storage.sync.set({ [STORAGE_KEY]: settings });
  }

  // Calls `callback(newSettings)` whenever the settings change, from any
  // context or from Firefox Sync. Returns a function that stops listening.
  function onChange(callback) {
    const listener = (changes, area) => {
      if (area === "sync" && STORAGE_KEY in changes) {
        callback(withDefaults(DEFAULTS, changes[STORAGE_KEY].newValue));
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }

  // Used by the background (the guardian, see background.js). Not
  // available in content scripts, which never call it.
  // Two sizes so Firefox picks the sharp one on normal and HiDPI screens.
  // The "off" moai is a greyed, faded copy of the normal one.
  function setToolbarIcon(active) {
    const name = active ? "moai" : "moai_off";
    return browser.action.setIcon({
      path: { 16: `/icons/${name}_16.png`, 32: `/icons/${name}_32.png` },
    });
  }

  const defaults = () => withDefaults(DEFAULTS, {});

  return Object.freeze({ load, save, onChange, setToolbarIcon, defaults });
})();
