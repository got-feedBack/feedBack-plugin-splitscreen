# Slopsmith Plugin: Split Screen

A plugin for [Slopsmith](https://github.com/got-feedback/feedBack) that shows 2–4 highway panels side-by-side during playback, each rendering a different arrangement of the same song. Practice lead and rhythm at once, watch bass against lead, or run a quad view of every arrangement a song has.

## Features

- **Five layouts** — Top/Bottom (2P), Left/Right (2P), Tri 1+2 (3P, one on top + two on bottom), Tri 2+1 (3P, two on top + one on bottom), and Quad (4P, 2×2 grid)
- **Per-panel arrangement selector** — each panel has its own dropdown; swap what it renders mid-playback without restarting the song
- **Per-panel visualization picker** — each panel can independently run any installed `slopsmithViz` plugin (e.g. the 3D highway) alongside the default 2D highway
- **Per-panel invert toggle** — flip individual panels between player and audience perspective independently
- **Per-panel note detection** — each panel can independently detect notes from a specific audio input channel; pairs with the [Note Detect](https://github.com/got-feedback/feedBack-plugin-notedetect) plugin for multi-guitar setups
- **Name your panels** — each panel has an editable name label pinned to its **top-right corner**. The name persists across sessions, is **carried when you pop the panel out**, and is exposed to other plugins (e.g. [Camera Director](https://github.com/nimuart/cameradirector_feedback) targets each panel's 3D-highway camera by name) via the panel API below.
- **Pop a panel into its own window** — click **⇱ Pop** at a panel's **top-right, next to its name**, to open it in a new browser window; drag it to a second monitor and resize it freely. The popup is muted and paused (it doesn't even decode the audio) and slaved to the main window's audio time, so there's still only one sound source. Click **⇲ Dock** (same spot) to send the panel back to its splitscreen slot; just closing the popup window instead removes that panel.
- **Split a popped window internally** — every popup gets its own bottom toolbar with a layout picker (Single / Top-Bottom / Left-Right / Quad). A popped window can mirror the same layouts as the main splitter, so you can run e.g. a quad on a second monitor with all four arrangements while the main window stays single-panel.
- **Hide/show bottom controls bar** — click **▾ Bar** (next to Close) to collapse the global player controls and reclaim the vertical space; a floating **▴ Controls** pill restores them
- **Hide/show per-panel mini bar** — each panel has a **▾ Bar** button pinned to its bottom-right corner to collapse that panel's controls independently; click **▴ Bar** to restore
- **Smart defaults** — opens with lead → rhythm → bass auto-assigned across panels when those arrangements exist, wrapping to fill the rest
- **Single shared audio** — all panels slave to the core `<audio>` element, so there's only one sound source and no drift between views
- **Live layout switching** — change layout from the player toolbar without reloading the song; existing arrangement selections are preserved when panel counts match
- **Persistent settings** — layout, per-panel arrangements, invert state, bar visibility, and controls bar visibility are all saved to `localStorage` and restored on the next visit

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/topkoa/slopsmith-plugin-splitscreen.git splitscreen
docker compose restart
```

**Compatibility** — splitscreen runs on any Slopsmith core. On cores with the `highway:visibility` plugin API (~0.2.7.1+), a visualization plugin that mounts a sibling overlay — e.g. the 3D Highway's WebGL overlay — hides itself cleanly while splitscreen is active. On older cores that overlay may bleed through the panels; update the core (and the 3D Highway plugin) to fix it.

## Usage

1. Open any song in the player.
2. Click the **Split** button in the player toolbar to activate. The highway is replaced by your configured layout of panels.
3. Use each panel's dropdown to pick which arrangement it shows. Click **Invert** on a panel to flip just that one.
4. Click **Split** again to return to the single-highway view.

Split screen works with any song that has more than one arrangement.

### Naming panels

Each panel shows an editable name (default `P1`, `P2`, …) at its **top-right corner**. Click it, type a name, and press Enter (or click away) to commit. Names persist across sessions and are carried into a popped-out window. Beyond being a label, the name is the **handle other plugins use to target a specific panel** — e.g. Camera Director lists panels by name so you can give each its own 3D-highway camera and steer popped-out panels from the main window.

### Hiding controls for more screen space

- **Bottom controls bar** — when splitscreen is active, a **▾ Bar** button appears next to the Close button. Click it to hide the player controls bar; panels expand to fill the freed space. A floating **▴ Controls** pill appears at the bottom-right of the player to bring the bar back.
- **Per-panel mini bar** — each panel has a **▾ Bar** button pinned to its bottom-right corner. Click it to collapse that panel's mini controls (arrangement picker, Invert, Lyrics, Tab, etc.); the highway fills the full panel height. Click **▴ Bar** to restore.

Both states are saved to `localStorage` and restored automatically the next time you activate splitscreen.

### Popping a panel onto a second monitor

Each panel has a **⇱ Pop** button at its **top-right, next to the panel name** (it stays reachable even when the panel's bottom mini-bar is hidden). Clicking it opens that panel in its own browser window, which you can then drag to a second monitor and resize independently — handy for multi-monitor practice setups where you want the highway, lyrics, or jumping tab on a separate screen from the main player. The panel's **name** is carried into the popped window, so tools that target panels by name (e.g. Camera Director) keep working across the pop-out.

While popped:

- The panel disappears from the main splitscreen layout (the slot collapses; if only one panel was left in main, the main window goes back to its default highway).
- The popup is **muted and paused** — it doesn't even decode the audio. Sound plays only from the main window; there's one source, never doubled or out of sync.
- Time is broadcast from the main window via `BroadcastChannel`, so the popup's highway / lyrics / jumping tab follows the main song precisely — and it stays smooth even if you give the popup focus and the main window goes into the background (the popup interpolates between updates).
- If you load a different song in the main window, popped panels **auto-follow** in their current mode + arrangement (clamped to arrangement 0 if the new song has fewer arrangements); rapid song-skips in the main window are coalesced so the popup just lands on the final one.

To bring it back: click **⇲ Dock** in the popup. The panel returns to its original splitscreen slot in the main window, with any per-panel changes you made in the popup (mastery, palette, camera smoothing, …) preserved.

Just **closing** the popup window does *not* re-dock the panel — it stays removed (its slot already collapsed when you popped it out). If you want the panel back, use **⇲ Dock** rather than closing the window; once it's closed, pop a fresh one from the main layout.

#### Splitting a popped window further

Every popup has a small toolbar pinned to its bottom edge with a **Layout** picker. The same layouts available in main are available here: **Single**, **Top/Bottom**, **Left/Right**, **Quad**. Switching layouts inside a popup keeps the slots you already configured and fills any new ones (lead → rhythm → bass) using the same smart-defaults the main toggle uses. Each popup has its own layout independent of main and any other popups, so you can run e.g. a quad of all four arrangements on a second monitor while keeping main on a single 3D highway.

> Pop-out uses standard `window.open` and `BroadcastChannel`. The popup must be triggered by your click (a user gesture) so popup blockers should leave it alone — but if your browser does block it (or doesn't support `BroadcastChannel`), the panel stays put and you get a brief notice instead. If you close the main window while popups are open, each popup detects it and shows a "main window closed" notice so you know to close it (best-effort — if the browser doesn't deliver that last message the popup just freezes, same as before).

## Settings

Open **Settings → Split Screen** to pick the default layout (Top/Bottom, Left/Right, Tri 1+2, Tri 2+1, or Quad). The choice is stored in `localStorage` as `splitscreenLayout` and applies the next time you toggle split screen on.

## Note Detection

Each panel can independently detect the notes you're playing and score your accuracy in real time. This requires the [Note Detect plugin](https://github.com/got-feedback/feedBack-plugin-notedetect) to be installed.

### Single input

Click **Detect** on any panel to enable note detection for that panel. The note detect HUD appears as an overlay and tracks your hits, misses, and streak independently from any other panels.

### Multiple inputs (e.g. Focusrite Scarlett)

If your audio interface has more than one input — for example a Scarlett 2i2 with two guitars — you can route each input to its own panel:

1. Plug guitar 1 into **input 1** (left channel) and guitar 2 into **input 2** (right channel).
2. In the first panel, click the channel button until it shows **L**.
3. In the second panel, click the channel button until it shows **R**.
4. Click **Detect** on both panels.

Each panel now listens to its own input and detects notes independently. Both players get their own accuracy HUD.

The channel button cycles through three modes:

| Label | Channel |
|-------|---------|
| **M** | Mono mix (both inputs combined) |
| **L** | Left channel only (input 1) |
| **R** | Right channel only (input 2) |

Your channel assignment is saved per panel and restored on the next visit. Detect is not re-enabled automatically on page load — you need to click it each session to trigger the microphone permission prompt.

> If note_detect is not installed the Detect and channel buttons are visible but disabled.

## How it works

Each panel is an independent highway instance:

1. Creates its own `<canvas>` and a fresh `Highway` via the core factory
2. Opens its own WebSocket to `/ws/highway/{filename}?arrangement={index}` so the server streams just that arrangement's notes/chords/beats
3. Overrides the highway's default `resize()` (which would size to the full window and clobber siblings) to size to its parent panel instead
4. Slaves its timeline to the shared core `<audio>` element — one sound source, N visualizers

Visualization panels (e.g. the 3D highway) use the core `setRenderer` contract: split screen calls `panel.hw.setRenderer(factory())` to install the renderer into the panel's existing highway instance. The highway manages the WebSocket and RAF loop; the renderer just draws.

On layout change, panels are torn down and rebuilt; arrangement selections are carried across when the new layout has at least as many panels as the old one. On player exit, `teardownPanels()` closes every WebSocket and removes the wrap div cleanly.

## Integrating Your Plugin With Split Screen

There are two integration paths depending on what your plugin does.

### Path 1: Visualization plugins (recommended)

If your plugin replaces the highway's draw function — a different way to render the same note data — use the core `slopsmithViz` contract (slopsmith#36). Declare `"type": "visualization"` in your `plugin.json` and export a renderer factory:

```js
window.slopsmithViz_my_viz = function () {
    return {
        init(canvas, bundle) {
            this.ctx = canvas.getContext('2d');
        },
        draw(bundle) {
            // bundle.currentTime, bundle.notes, bundle.chords, bundle.beats, etc.
        },
        resize(w, h) { /* optional */ },
        destroy()    { /* optional — release resources */ },
    };
};
```

Split screen automatically populates each panel's dropdown with this option and calls `panel.hw.setRenderer(factory())` when selected. **No changes to split screen's code are needed.** Each panel gets an independent renderer instance; the highway provides note data, timing, and the RAF loop.

See the [CLAUDE.md plugin guide](https://github.com/got-feedback/feedBack/blob/main/CLAUDE.md) for the full `setRenderer` lifecycle and bundle shape. The [3D Highway plugin](https://github.com/got-feedback/feedBack-plugin-3dhighway) is a reference implementation.

### Path 2: Pane plugins (own canvas + own WebSocket)

If your plugin needs a fundamentally different rendering approach — its own canvas, its own WebSocket connection, DOM elements that aren't a highway at all — use the pane factory contract. Lyrics and Jumping Tab use this path.

Your factory must accept `{ container }` and return `{ connect(), destroy(), resize() }`:

```js
window.createMyVisualization = function ({ container }) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    container.appendChild(canvas);

    let ws = null;
    let raf = null;
    let destroyed = false;

    function render() {
        if (destroyed) return;
        const now = document.getElementById('audio')?.currentTime ?? 0;
        // ... draw ...
        raf = requestAnimationFrame(render);
    }

    return {
        connect(filename, arrangementIndex) {
            // filename may be percent-encoded — decode it before building the URL:
            const decoded = decodeURIComponent(filename);
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = `${proto}//${location.host}/ws/highway/${decoded}?arrangement=${arrangementIndex}`;
            ws = new WebSocket(url);
            // ... handle messages, call render() when ready ...
        },
        destroy() {
            destroyed = true;
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            if (ws) { ws.close(); ws = null; }
            if (canvas.parentNode) canvas.remove();
        },
        resize() {
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            canvas.width = Math.floor(rect.width * dpr);
            canvas.height = Math.floor(rect.height * dpr);
        },
    };
};
```

#### Key rules for pane plugins

| Rule | Why |
|------|-----|
| **No shared mutable state** | Split screen may create 2–4 instances simultaneously. Each needs its own canvas, WebSocket, RAF handle, and state. If your plugin uses module-level variables, use a context-swap pattern (see Jumping Tab) or refactor to closures. |
| **Decode the filename** | `currentFilename` may be percent-encoded. Call `decodeURIComponent(filename)` before building the WebSocket URL to avoid double-encoding slashes. |
| **Sync to `<audio>` directly** | Read `document.getElementById('audio').currentTime` in your RAF loop. The `setTime()` call from split screen's time sync loop is for highway instances only. |
| **Clean up completely in `destroy()`** | Cancel RAF, close WebSocket, remove any DOM nodes you added inside the container. Split screen removes the container div itself. |
| **Handle `resize()` properly** | Called on layout changes and window resizes. Update your canvas backing store respecting `devicePixelRatio`. |
| **No arrangement assumptions** | `connect()` receives an arrangement index — honor it. |

#### Registering a pane plugin with split screen

Pane plugins require a small integration in split screen's `screen.js` (unlike viz plugins, which are auto-discovered). The pattern:

**1.** Define a sentinel value for dropdown values and preference storage:
```js
const MY_VIZ_VALUE = '__my_viz__';
```

**2.** Add options to `populateSelect()`, gated on your factory:
```js
if (typeof window.createMyVisualization === 'function') {
    arrangements.forEach((a, i) => {
        const opt = document.createElement('option');
        opt.value = MY_VIZ_VALUE + ':' + i;
        opt.textContent = (a.name || `Arr ${i}`) + ' (MyViz)';
        panel.select.appendChild(opt);
    });
}
```

**3.** Add `enterMyVizMode(panel)` / `exitMyVizMode(panel, arrIndex)` functions following the lyrics or jumping tab pattern.

**4.** Wire into `select.onchange`, `initPanel()`, `teardownPanels()`, `savePanelPrefs()`, `captureCurrentPrefs()`, `sizeCanvases()`, and `startTimeSync()`.

#### Reference implementations

- **Lyrics pane** — `createLyricsPane()` in [screen.js](screen.js). DOM-based renderer, single WebSocket, RAF loop for karaoke highlighting.
- **Jumping Tab pane** — `window.createJumpingTabPane()` in the [Jumping Tab plugin](https://github.com/renanboni/slopsmith-plugin-jumpingtab). Canvas renderer with context-swapping to share draw functions across multiple pane instances.

### Per-panel identity & names (for panel-targeting plugins)

Plugins that need to act on individual panels — apply a per-panel setting, mount panel-scoped chrome, or (like Camera Director) drive a per-panel camera — read the panel registry off `window.feedBackSplitscreen` (alias `window.slopsmithSplitscreen`; prefer `window.feedBackSplitscreen || window.slopsmithSplitscreen`):

```js
const ss = window.feedBackSplitscreen || window.slopsmithSplitscreen;
if (ss && ss.isActive()) {
    for (const p of ss.getPanels()) {
        // p = { index, name, canvas, focused, poppedOut }
        console.log(p.index, p.name, p.focused);
    }
}
```

| Member | Returns / effect |
|--------|------------------|
| `isActive()` | `true` while split (or in a follower window that has built its panels) |
| `getPanels()` | `[{ index, name, canvas, focused, poppedOut }]` for the current window — including a **follower window's own panels** once it has split |
| `panelIndexFor(canvas)` | the panel index a highway `canvas` belongs to (or `null`) |
| `isCanvasFocused(canvas)` | whether that canvas's panel is the focused one |
| `panelName(i)` / `setPanelName(i, name)` | read / set a panel's name |
| `onFocusChange(fn)` / `offFocusChange(fn)` | subscribe to focus changes |
| `panelChromeFor(canvas)` / `settingsAnchorFor(canvas)` | DOM anchors for per-panel overlays / buttons |

Panel add/remove/rename (and a follower re-splitting) fires **`splitscreen:panels-changed`** on the `window.feedBack` event bus — re-read `getPanels()` when you receive it. Names are per-window; a popped-out panel carries its name into its follower window, and that window's own `getPanels()` exposes any panels it splits into (so a panel-targeting plugin can address them too). The [Camera Director plugin](https://github.com/nimuart/cameradirector_feedback) is a reference consumer — it lists every window's panels by name and can steer popped-out panels from the main window.

### Testing Checklist

Before shipping, verify:

- [ ] Multiple panels can run your visualization simultaneously without interference
- [ ] Switching between your mode and highway/lyrics/jumping tab transitions cleanly
- [ ] `destroy()` (pane) or the `destroy()` renderer method (viz) leaves no orphaned RAF loops, WebSocket connections, or DOM nodes
- [ ] Preferences persist across songs (correct arrangement restores)
- [ ] Your dropdown options don't appear when your plugin is not installed
- [ ] Resizing the browser or switching layouts updates your canvas correctly

### WebSocket Data Reference

The highway WebSocket (`/ws/highway/{filename}?arrangement={index}`) streams these messages in order:

| Message | Shape | Description |
|---------|-------|-------------|
| `song_info` | `{ type, title, artist, arrangement, duration, tuning }` | Song metadata and tuning array (6 elements for guitar, 4 for bass) |
| `sections` | `{ type, data: [{ time, name }] }` | Named sections (Intro, Verse, Chorus, etc.) |
| `notes` | `{ type, data: [{ t, s, f, sus, ho, po, sl, bn }] }` | Single notes — `t`=time, `s`=string, `f`=fret, `sus`=sustain, technique flags |
| `chords` | `{ type, data: [{ t, notes: [{ s, f, sus, ho, po, sl, bn }] }] }` | Chord events — each has a time and an array of per-string notes |
| `beats` | `{ type, data: [{ time, measure }] }` | Beat timestamps with measure numbers |
| `lyrics` | `{ type, data: [{ w, t, d }] }` | Syllables — `w`=word, `t`=time, `d`=duration. `-` joins to previous word, `+` marks line break |
| `ready` | `{ type: 'ready' }` | All data has been sent — safe to finalize and start rendering |

Messages arrive in the order listed above. Do not start rendering until you receive `ready`.

## Requirements

- Slopsmith with the highway factory (`createHighway()`) and `setRenderer` support exposed on `window` — available in all recent builds (slopsmith#36)
- A song with ≥2 arrangements to see any benefit; 1-arrangement songs simply render the same view in every panel

## Other Plugins

- [Stems](https://github.com/topkoa/slopsmith-plugin-stems) — live multi-stem mixer for `.sloppak` songs

## License

MIT
