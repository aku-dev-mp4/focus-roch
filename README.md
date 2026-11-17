# Focus roc'h

A Firefox extension that hides YouTube's distractions (home feed,
recommendations, end screens, comments, Shorts shelves...) so you can use
YouTube on purpose.

- **Two modes**, chosen after installation:
  - **normal** (recommended): every setting applies at once, quick popup on
    the toolbar button;
  - **hardcore**: turning protection back down is deliberately slow (focus
    timer, delay, weekly quota, locked hours); strengthening it is always
    instant.
- Extras: audio-only mode (hides the picture and forces 144p to save data),
  transcript buttons, lighter live chat.
- Interface in English, French and Simplified Chinese.
- **Private by design**: everything runs locally. No server, no tracking, no
  data sent anywhere.

## Install (development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox (140 or newer).
2. *Load Temporary Add-on…* and pick `manifest.json` at the root of this repository.

To build a package:

```sh
npx web-ext build
```

## Repository layout

| Path | Content |
|---|---|
| `manifest.json`, `background.js` | extension manifest (Manifest V3) and background "guardian" |
| `content/` | scripts and styles injected into YouTube |
| `options/`, `popup/` | settings page and toolbar popup |
| `shared/` | settings, friction rules and shared styles |
| `_locales/`, `icons/`, `fonts/` | translations shown by Firefox, icons, bundled font |

Plain HTML/CSS/JS, no dependencies, no build step.

## License

Focus roc'h is free software, released under the
[GNU General Public License v3.0](LICENSE).

Started as a rewrite of DF YouTube (Distraction Free) by RickyV; the code
was rewritten from scratch.

## Credits

- Extension icon: 🗿 from Noto Emoji (animated/3D set) by Google, licensed
  under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Resized
  from the original.
- Interface font: JetBrains Mono by JetBrains, licensed under the SIL Open
  Font License 1.1 (`fonts/OFL.txt`).
