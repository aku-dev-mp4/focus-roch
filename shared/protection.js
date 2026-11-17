/*
 * shared/protection.js
 *
 * The rules of the "friction" system, shared by the background (which
 * enforces them) and the options page (which displays them). Pure functions
 * and constants only: no storage access, no messages.
 *
 * The principle: making protection STRONGER is always instant; making it
 * WEAKER (turning the extension off, un-hiding something, relaxing the
 * friction itself) needs a request that goes through:
 *   quota and locked-hours check -> focus timer -> delay -> applied.
 *
 * Profiles only set the friction values (delay, focus time, weekly quota,
 * locked hours). What is hidden on YouTube stays entirely up to you.
 *
 * Needs shared/settings.js loaded first (for the list of settings).
 */
"use strict";

const DFProtection = (() => {
  const STORAGE_KEY = "dfytProtection";

  /* -------------------------------------------------------------------- */
  /* Which settings are "protective"                                      */
  /* -------------------------------------------------------------------- */

  // For every one of these, `true` means "protected". Switching one from
  // true to false weakens protection; anything else is free.
  // Comfort options (transcript buttons, audio mode, lighter chat, playlists)
  // are not listed: changing them is always instant.
  // disableAutoplay is protective: autoplay is what chains videos together.
  const PROTECTIVE_PATHS = [
    "active",
    "disableAutoplay",
    ...Object.keys(DFSettings.defaults().visibility).map((key) => `visibility.${key}`),
  ];

  const isProtective = (path) => PROTECTIVE_PATHS.includes(path);

  // "visibility.hideFeed" -> settings.visibility.hideFeed
  function getPath(object, path) {
    return path.split(".").reduce((value, key) => value?.[key], object);
  }

  function setPath(object, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const parent = keys.reduce((value, key) => (value[key] ??= {}), object);
    parent[last] = value;
  }

  // The protective part of a settings object, as { path: boolean }.
  function snapshot(settings) {
    return Object.fromEntries(PROTECTIVE_PATHS.map((path) => [path, getPath(settings, path) === true]));
  }

  // True if changing `path` from `before` to `after` weakens protection.
  const weakens = (path, before, after) => isProtective(path) && before === true && after === false;

  /* -------------------------------------------------------------------- */
  /* Profiles                                                             */
  /* -------------------------------------------------------------------- */

  const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]; // 0 = Sunday, like Date.getDay()
  const WEEKDAYS = [1, 2, 3, 4, 5];

  const PROFILES = {
    soft: {
      label: "Souple",
      friction: { delayMin: 120, focusMin: 20, weeklyQuota: 5, lockedHours: [] },
    },
    balanced: {
      label: "Équilibré",
      friction: { delayMin: 720, focusMin: 20, weeklyQuota: 3, lockedHours: [] },
    },
    strict: {
      label: "Strict",
      friction: {
        delayMin: 1440,
        focusMin: 20,
        weeklyQuota: 2,
        lockedHours: [{ days: EVERY_DAY, from: "22:00", to: "07:00" }],
      },
    },
    detox: {
      label: "Détox",
      friction: {
        delayMin: 2880,
        focusMin: 20,
        weeklyQuota: 1,
        lockedHours: [
          { days: EVERY_DAY, from: "22:00", to: "07:00" },
          { days: WEEKDAYS, from: "09:00", to: "18:00" },
        ],
      },
    },
  };

  // Bounds for the "custom" profile. A quota of 0, or locked hours covering
  // the whole week, would make every future change impossible, including
  // relaxing the friction itself: a trap with no way out except
  // reinstalling. So both are refused.
  const LIMITS = {
    delayMin: [60, 10080], // 1 hour to 7 days
    focusMin: [10, 60],
    weeklyQuota: [1, 14],
  };

  const clamp = (value, [min, max]) => Math.min(Math.max(Math.round(Number(value) || 0), min), max);
  const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

  // Cleans any friction object (from the custom form, or from storage).
  function normalizeFriction(friction) {
    const lockedHours = (Array.isArray(friction?.lockedHours) ? friction.lockedHours : [])
      .map((rule) => ({
        days: [...new Set((rule.days ?? []).map(Number))].filter((day) => day >= 0 && day <= 6).sort(),
        from: TIME_PATTERN.test(rule.from) ? rule.from : "00:00",
        to: TIME_PATTERN.test(rule.to) ? rule.to : "00:00",
      }))
      .filter((rule) => rule.days.length > 0 && rule.from !== rule.to);
    return {
      delayMin: clamp(friction?.delayMin, LIMITS.delayMin),
      focusMin: clamp(friction?.focusMin, LIMITS.focusMin),
      weeklyQuota: clamp(friction?.weeklyQuota, LIMITS.weeklyQuota),
      lockedHours,
    };
  }

  /* -------------------------------------------------------------------- */
  /* Locked hours                                                         */
  /* -------------------------------------------------------------------- */

  // The week is cut into 15-minute slots (7 days x 96 slots). Each rule marks
  // the slots it locks. A rule whose end is before its start ("22:00" to
  // "07:00") runs past midnight into the next day. A grid makes the two
  // questions we need trivial: "is this moment locked?" and "does the new
  // schedule unlock any slot that used to be locked?".
  const SLOTS_PER_DAY = 96;
  const SLOTS_PER_WEEK = 7 * SLOTS_PER_DAY;
  const toSlot = (time) => {
    const [hours, minutes] = time.split(":").map(Number);
    return Math.floor((hours * 60 + minutes) / 15);
  };

  function lockGrid(lockedHours) {
    const grid = new Uint8Array(SLOTS_PER_WEEK);
    for (const rule of lockedHours) {
      const start = toSlot(rule.from);
      const end = toSlot(rule.to);
      for (const day of rule.days) {
        const length = end > start ? end - start : SLOTS_PER_DAY - start + end;
        for (let i = 0; i < length; i++) {
          grid[(day * SLOTS_PER_DAY + start + i) % SLOTS_PER_WEEK] = 1;
        }
      }
    }
    return grid;
  }

  const slotOf = (date) =>
    date.getDay() * SLOTS_PER_DAY + Math.floor((date.getHours() * 60 + date.getMinutes()) / 15);

  function isLocked(friction, date = new Date()) {
    return lockGrid(friction.lockedHours)[slotOf(date)] === 1;
  }

  // The first moment from `date` that isn't locked (null if all is locked).
  function nextUnlock(friction, date = new Date()) {
    const grid = lockGrid(friction.lockedHours);
    const start = slotOf(date);
    for (let i = 0; i < SLOTS_PER_WEEK; i++) {
      if (grid[(start + i) % SLOTS_PER_WEEK] === 0) {
        if (i === 0) return new Date(date);
        const next = new Date(date);
        next.setSeconds(0, 0);
        next.setMinutes(Math.floor(next.getMinutes() / 15) * 15 + i * 15);
        return next;
      }
    }
    return null;
  }

  const coversWholeWeek = (lockedHours) => lockGrid(lockedHours).every((slot) => slot === 1);

  /* -------------------------------------------------------------------- */
  /* Comparing friction settings                                          */
  /* -------------------------------------------------------------------- */

  // True if `after` is easier to get through than `before` in ANY respect:
  // shorter delay, shorter focus, bigger quota, or a time slot that was
  // locked and no longer is. Such a change needs a request.
  function frictionWeakens(before, after) {
    if (after.delayMin < before.delayMin) return true;
    if (after.focusMin < before.focusMin) return true;
    if (after.weeklyQuota > before.weeklyQuota) return true;
    const oldGrid = lockGrid(before.lockedHours);
    const newGrid = lockGrid(after.lockedHours);
    return oldGrid.some((locked, slot) => locked === 1 && newGrid[slot] === 0);
  }

  /* -------------------------------------------------------------------- */
  /* Weekly quota                                                         */
  /* -------------------------------------------------------------------- */

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Requests applied during the last 7 days (rolling, not calendar weeks).
  function quotaUsed(history, now = Date.now()) {
    return history.filter((entry) => now - entry.appliedAt < WEEK_MS).length;
  }

  // When the oldest counted request leaves the 7-day window.
  function quotaFreesAt(history, now = Date.now()) {
    const recent = history.filter((entry) => now - entry.appliedAt < WEEK_MS);
    if (recent.length === 0) return now;
    return Math.min(...recent.map((entry) => entry.appliedAt)) + WEEK_MS;
  }

  return Object.freeze({
    STORAGE_KEY,
    PROTECTIVE_PATHS,
    PROFILES,
    LIMITS,
    isProtective,
    getPath,
    setPath,
    snapshot,
    weakens,
    normalizeFriction,
    isLocked,
    nextUnlock,
    coversWholeWeek,
    frictionWeakens,
    quotaUsed,
    quotaFreesAt,
  });
})();
