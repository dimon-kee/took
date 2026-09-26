# Took — screenshots & screen recording

English · [简体中文](README.zh-CN.md)

A Windows screenshot-and-annotate plus region-recording tool, built on Electron.

## Running it

```bash
task install
task dev
```

`task` with no arguments lists everything. The ones you will use:

| Command | What it does |
| --- | --- |
| `task dev` / `task d` | Start the app |
| `task stop` / `task s` | Kill it (it lives in the tray, so closing a window will not) |
| `task restart` / `task r` | Stop, then start |
| `task preview` / `task p` | Render the overlay's states into `.preview/` |
| `task check` / `task c` | Run every self-check |
| `task dist` | Build the Windows installer into `dist/` |

Without go-task installed, `npm start` / `npm run dev` / `npm run dist` work too.

## Start with Windows

Tick "Start with Windows" in the tray menu, or:

```bash
task autostart:on
```

This writes a value named `Took` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` — current user only, no admin rights needed. `task autostart` reports the current state and `task autostart:off` removes it.

At boot the app goes straight to the tray without opening a window.

> Unpackaged, the registered command is `electron.exe <project dir>`, which depends on `node_modules` still being there. After `task dist` and installing the packaged build, toggle the setting off and on once so the registry points at the installed exe — both share one registry value, so you never end up with two start-up entries.

## Hotkeys

| Key | Action |
| --- | --- |
| `Ctrl + Shift + S` | Screenshot |
| `Ctrl + Shift + R` | Screen recording |

Those are the defaults; both can be changed from the tray menu's settings window — see [Settings](#settings).

The app shows no window at all until a hotkey fires. Then the whole screen freezes and a `⋮⋮ Capture │ Record` mode bar floats in at the top; everything disappears once you finish. The bar can be dragged, and it steps out of the way as soon as you pick an annotation tool.

## Screenshots

A pixel loupe follows the cursor across the frozen screen.

The moment it opens **the whole display is already selected** — no dim, a thin border, the size shown in the corner.

- **Click** to accept the full screen; `Ctrl + A` does the same
- **Drag** to replace that default with your own region; the corner shows `width x height` live

A one or two pixel shake during a click will not break the pre-selection — the pointer has to travel past a threshold before it counts as a drag.

- Once a region is set, eight handles adjust the edges and dragging inside moves the whole box
- Arrow keys nudge the position, `Shift + arrows` nudge the size

### Colour picking

Before a region is drawn, the loupe reports the coordinate and colour under the cursor:

- `Ctrl + C` copies the value
- `Shift` switches between `RGB:255,255,255` and `HEX:#FFFFFF`

The crosshair is blue in screenshot mode and pink in recording mode.

### Annotation

A toolbar appears below the region, aligned to its right edge.

Drawing: rectangle, ellipse, line, arrow, pen, text, highlighter
Processing: mosaic, blur, eraser (click a stroke to remove it)
Output: pin to screen, decode QR, undo, save, cancel, done

Picking any drawing tool opens a second row: three stroke widths and seven colours. The text tool's size follows the width setting.

| Key | Action |
| --- | --- |
| `Enter` | Done — copy to clipboard |
| `Ctrl + S` | Save as PNG |
| `Ctrl + Z` | Undo the last stroke |
| `Ctrl + C` | Copy to clipboard |
| `Esc` | Drop the current tool; again to cancel the capture |
| Right click | Step back: tool → region → exit |

QR decoding reads the untouched pixels, so annotations drawn on top do not interfere.

### Pinning

The pin in the toolbar turns the region into an always-on-top window that stays where it was. Drag to move, scroll to change opacity, hover for copy / save / close in the corner, double-click or `Esc` to dismiss.

## Screen recording

Switching to Record keeps the same region selection. Once a region is set, a setup card appears in the middle of it:

- **Start recording**
- **Format** — MP4 or GIF
- **System audio** — captured through desktop loopback
- **Microphone** — click the icon to toggle, the caret to pick a device
- **Camera** — same, and a picture-in-picture bubble appears in the bottom-left of the region
- **Cursor** — the caret holds *Highlight the cursor* and *Show click ripples*

Choosing GIF collapses the audio row entirely — a GIF carries no audio track.

### The webcam bubble

The bubble is a separate always-on-top window, not a layer composited into the frame. That is what lets you drag and resize it freely, and it keeps working during the recording because the screen grab picks it up on its own.

Hovering reveals a toolbar: rounded-rectangle or circle shape, and a gear holding *Mirror*, *Soften* and *Blur background*.

> *Blur background* uses Chromium's `backgroundBlur` track capability, which needs support from both the camera and the OS. When it cannot be detected the option is greyed out rather than faked in software — doing that properly would mean shipping a multi-megabyte segmentation model. *Mirror* and *Soften* always work.

### While recording

A control bar sits beside the region: `⋮⋮ ⏸ 00:00:05 / 01:00:00 [Stop] ✕`

Space pauses and resumes, `Enter` finishes, `Esc` discards. One hour is the cap, after which it stops on its own.

### The editor window

When you stop, an *Edit recording* window opens: player, scrubber, *Save* and *Copy to clipboard*. The file sits in a temp directory until you decide where it goes.

Copying an MP4 puts a file reference on the clipboard, which pastes into Explorer and chat apps; a GIF additionally goes on as a bitmap.

> This version previews and exports only — there is no trim timeline.

## Output formats

| | Codec | Notes |
| --- | --- | --- |
| MP4 | H.264 + AAC | Native to MediaRecorder, no ffmpeg needed |
| GIF | gifenc | 10fps, 640px wide at most, one 256-colour palette for the whole clip |

Screenshots are always PNG at **native resolution**. On a 1920×1080 screen at 125% scaling you get a real 1920×1080 image, not an upscaled 1536×864 one.

## Settings

Tray menu → Settings…

**Language** — English (the default) or 简体中文. It covers the tray menu, every window and the file dialogs. Windows already open keep their language until they are next opened; the settings window rebuilds itself straight away so you see the change.

**Hotkeys** — click the field and press the combination you want. At least one modifier is required, otherwise that key would be swallowed system-wide. If a combination is already taken by another program the row turns red and **nothing is saved at all** — you never end up with half your hotkeys broken. Each row has a reset link.

**Save location** — where the save dialogs for screenshots and recordings start, and where the tray's "Open save folder" goes. Defaults to `Pictures/Took/`. A new directory is probe-written before it is accepted, so an unwritable path is rejected on the spot rather than when you try to save a capture.

Settings live in `%APPDATA%\Took\settings.json`. A corrupt or missing file falls back to defaults instead of failing to start. If the directory later disappears — external drive unplugged, folder deleted — captures fall back to `Pictures/Took` rather than being lost.

## Layout

```
src/
├── main/                main process
│   ├── index.js           lifecycle, tray, global hotkeys, all IPC
│   ├── capture.js         describes displays; PNG fallback capture
│   ├── screens.js         cached desktopCapturer source IDs
│   ├── settings.js        persisted preferences
│   ├── cursor.js          global pointer position + click edges (koffi → user32)
│   ├── autolaunch.js      start-with-Windows registration
│   ├── win32.js           Win32 bits Electron does not expose
│   └── windows.js         window construction
├── preload/             contextBridge for each window
└── renderer/
    ├── overlay/           the capture overlay (the core)
    │   ├── overlay.js       state machine, events, render scheduling, export
    │   ├── shapes.js        annotation primitives and hit testing
    │   ├── magnifier.js     pixel loupe
    │   ├── recordpanel.js   recording setup card
    │   └── icons.js         toolbar icons
    ├── recorder/          hidden worker window that owns the capture
    ├── recordbar/         recording control bar
    ├── webcam/            webcam bubble
    ├── editor/            post-recording preview
    ├── settings/          settings window
    └── pin/               pinned screenshot window
```

### Design notes

**The overlay is four stacked canvases**: `base` for the frozen screenshot (drawn once), `mask` for the dim with a hole at the selection, `shapes` for committed annotations, and `live` for the stroke in progress plus the selection chrome. Each is marked dirty independently and flushed by a single rAF, so dragging never repaints the whole screen.

**Coordinates are kept in CSS pixels** while the canvases' backing stores stay at the display's native resolution, bridged by `ctx.setTransform(ratio, …)`. That is why exports on a high-DPI screen come out native.

**Screenshots avoid desktopCapturer on the hot path.** `desktopCapturer.getSources` costs about a second on Windows regardless of thumbnail size — the enumeration is expensive, not the pixels. Source IDs are resolved once at startup and cached (refreshed when the display layout changes); the overlay then grabs its own frame from a MediaStream. That skips the enumeration as well as a PNG encode in main, a multi-megabyte IPC payload and a decode in the renderer.

Hotkey to visible is about 600ms, down from 1900ms. `task check:latency` measures it and checks the grabbed frame is not blank.

**The overlay window is transparent, not black.** Windows paints a window's background brush before the renderer's surface reaches the screen, and on a fullscreen window that frame is very visible — `task check:flash` measured luminance dropping from 31 to 2. With no brush to paint, that frame shows the real desktop, which is indistinguishable from the screenshot about to replace it. Open and close animations are disabled via `DwmSetWindowAttribute`.

**Recording has no native cropping**: the whole screen comes in as a MediaStream, the selected region is redrawn frame by frame into a canvas, and that canvas is recorded. Cursor highlight and click ripples are painted in the same step.

**Click detection cannot come from Electron**, which exposes the pointer position but not button state. koffi polls `user32!GetAsyncKeyState` at 60Hz, main does the edge detection and pushes it to the recorder. If the FFI binding fails to load it degrades to highlight only, with no click effect.

## Development tools

Everything under `tools/` has a matching task:

| Script | Task | Purpose |
| --- | --- | --- |
| `preview-ui.js` | `task preview` | Renders every overlay state against a synthetic desktop as PNGs. The overlay is fullscreen and always-on-top, so DevTools is not an option — this is how UI changes get checked |
| `preview-settings.js` | `task preview` | Renders the settings window, including the key-capture and hotkey-clash states |
| `check-i18n.js` | `task check:i18n` | Both languages define the same keys, every referenced key exists, none are dead, and no user-facing Chinese is left hardcoded |
| `check-scripts.js` | `task check:scripts` | Several classic scripts share each page's global scope; a top-level redeclaration between them stops the later one loading, and `node --check` cannot see it |
| `check-settings.js` | `task check:settings` | Exercises the settings store, the save-path fallback and the hotkey conflict rollback |
| `check-latency.js` | `task check:latency` | Times the hotkey-to-overlay path and confirms the grabbed frame is not blank |
| `check-capture-speed.js` | `task check:capture-speed` | Breaks down where desktopCapturer spends its time versus a MediaStream frame grab — the evidence for not using it on the hot path |
| `check-flash.js` | `task check:flash` | Films the overlay appearing and measures per-frame luminance, turning "it flashes" into a number |
| `check-capture.js` | `task check:capture` | Reports each display's size, scale factor and the resolution actually captured |
| `check-media.js` | `task check:media` | Probes MediaRecorder codecs, desktop loopback audio and available devices |
| `check-record.js` | `task check:record` | Records a few seconds end to end and verifies MP4 / GIF container structure and frame count. Deletes the clips afterwards |
| `make-icons.js` | `task icons` | Generates the icon PNGs in `assets/` from code, so the repository carries no binary art |
| `autostart.js` | `task autostart[:on\|:off]` | Start-with-Windows toggle and status |

## Licence

[MIT](LICENSE)
