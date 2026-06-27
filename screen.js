// ── Desktop-bridge back-compat ──────────────────────────────────────────────
// The host renamed window.slopsmithDesktop → window.feedBackDesktop
// (got-feedback/feedBack-desktop#40). On desktop builds that still expose only
// the legacy name, alias it so the feedBackDesktop reads below work on every
// desktop in any release order. No-op in the browser and on the new bridge.
try {
    if (typeof window !== 'undefined' && !window.feedBackDesktop && window.slopsmithDesktop) {
        window.feedBackDesktop = window.slopsmithDesktop;
    }
} catch (_) { /* frozen window — ignore */ }

(function () {
    'use strict';

    /* ======================================================================
     *  Split Screen Plugin
     *  Creates 2-4 independent highway panels, each showing a different
     *  arrangement from the same song. All panels sync to the shared
     *  <audio> element.
     * ====================================================================== */

    const LAYOUTS = {
        'top-bottom':  { panels: 2, style: 'flex-col' },
        'left-right':  { panels: 2, style: 'flex-row' },
        'tri-top':     { panels: 3, style: 'grid-tri' },
        'tri-bottom':  { panels: 3, style: 'grid-tri' },
        'quad':        { panels: 4, style: 'grid-2x2' },
    };

    const OFF_CLASS = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    const ON_CLASS  = 'px-3 py-1.5 bg-blue-900/50 hover:bg-blue-900/60 rounded-lg text-xs text-blue-300 transition';

    // v3 host exposes a stable plugin-control slot (the Plugins rail popover).
    function _ssIsV3() {
        return !!(window.slopsmith && window.slopsmith.uiVersion === 'v3');
    }
    // Returns the slot element in v3, or null (classic UI / unavailable).
    function _ssPlayerControlSlot() {
        if (!(_ssIsV3() && window.slopsmith.ui && typeof window.slopsmith.ui.playerControlSlot === 'function')) return null;
        try { const s = window.slopsmith.ui.playerControlSlot(); return s instanceof Element ? s : null; }
        catch (_e) { return null; }
    }
    const STORAGE_KEY = 'splitscreenPanelPrefs';
    const LYRICS_VALUE       = '__lyrics__';
    const JUMPING_TAB_VALUE  = '__jumping_tab__';
    const VIZ_PREFIX         = '__viz__';
    // Per-panel input channel selection. Keys stay strings for backward-compat with
    // saved prefs and to keep the `|| 'mono'` defaults safe (channel 0 would be a
    // falsy integer). 'left'/'right' are input channels 1/2; 'M' = mono mix.
    // DETECT_CHANNEL_VALUE maps each to the engine channel index (-1 = mono mix, else
    // 0-based). Multi-channel selection (channels 3+ of one interface) is DEFERRED —
    // it needs the device's real channel count + capture-mode-aware gating in the
    // detector; the validated multi-device flow binds ONE device per panel via the
    // device picker, so mono/left/right is sufficient. A saved 'ch3'+ pref clamps to
    // mono on load (see setupDetect).
    const DETECT_CHANNEL_CYCLE  = ['mono', 'left', 'right'];
    const DETECT_CHANNEL_LABELS = { mono: 'M', left: '1', right: '2' };
    const DETECT_CHANNEL_VALUE  = { mono: -1, left: 0, right: 1 };

    // Phase 2 multi-device: lazily assign a stable engine deviceKey (1..3) to each
    // distinct ADDITIONAL input device a panel picks, so two panels on two separate
    // interfaces each get their own own-clock source. "Main" (the primary input)
    // stays deviceKey 0 and is never bound here. The engine caps extra devices at 3.
    const SS_MAX_EXTRA_DEVICES = 3;
    const _ssDeviceKeyByName = new Map();  // device name -> deviceKey (1..3)
    let _ssMainDetectWasOn = false;        // restore the main-player detector on teardown
    // Whether split mode currently owns detection (the default singleton is suppressed).
    // Splitscreen-owned (don't read note_detect's internal flag), so a rebuild knows to
    // KEEP the captured _ssMainDetectWasOn instead of re-capturing it after the
    // singleton was already disabled (which would lose the original on-state).
    let _ssDetectSuppressed = false;
    // True while teardownPanels() runs as part of a REBUILD (resize / arrangement
    // switch) that immediately restarts. In that case we must NOT release the extra
    // input devices or restore the main detector: doing so unbinds the interfaces and
    // then rebinds them a tick later (async unbind racing the rebind can hand a panel
    // a stale device), plus blips the main HUD. Real stops leave it false → full
    // cleanup. Set only by rebuildLayout(), around its synchronous teardown.
    let _ssTransientTeardown = false;
    // Resolves when the previous session's extra-device unbinds have completed.
    // A teardown fires unbindInputDevice() (async) and frees the deviceKeys; the next
    // session must NOT rebind a key before its old device is actually released, or the
    // late-completing unbind tears down the freshly-rebound device. _ssApplyDevice()
    // awaits this before binding. Resolved (no-op) when nothing is pending.
    let _ssDeviceReleaseBarrier = Promise.resolve();
    // Bumped on every REAL stop (full teardown, not a rebuild). An in-flight
    // _ssApplyDeviceImpl captures it and, if it finds itself on a detached panel,
    // uses it to tell a real stop (release the device it just bound — the stop's
    // unbind-all ran before this late bind) from a rebuild (the binding is preserved
    // + likely reused by the new panel, so leave it).
    let _ssRealStopGen = 0;
    // Allocate the lowest free deviceKey (reusing keys freed by unbind), so
    // switching devices doesn't leak keys until the pool is exhausted.
    function _ssResolveDeviceKey(name) {
        if (_ssDeviceKeyByName.has(name)) return _ssDeviceKeyByName.get(name);
        const used = new Set(_ssDeviceKeyByName.values());
        for (let k = 1; k <= SS_MAX_EXTRA_DEVICES; k++)
            if (!used.has(k)) { _ssDeviceKeyByName.set(name, k); return k; }
        return -1;  // all keys in use
    }
    const _ssAudio = () =>
        (typeof window !== 'undefined' && window.feedBackDesktop && window.feedBackDesktop.audio) || null;

    // Suppress / restore the note_detect default singleton (so it doesn't render a
    // duplicate HUD over panel 1 in split mode). Prefer the plugin's own setter so the
    // mechanism stays owned by note_detect; fall back to the shared flag on an older build.
    function _ssSetDefaultSuppressed(v) {
        const cnd = (typeof window !== 'undefined') ? window.createNoteDetector : null;
        if (cnd && typeof cnd.setDefaultSuppressed === 'function') cnd.setDefaultSuppressed(v);
        else if (typeof window !== 'undefined') window.__ndSuppressDefault = !!v;
    }

    // Unbind an extra device once NO panel is using it, freeing its engine slot +
    // deviceKey. Called when a panel switches away from a device (or is torn down),
    // so re-picking devices can't accumulate stale binds (which crossed sources +
    // duplicated scores). No-op for "" (Main) or a device another panel still uses.
    async function _ssMaybeUnbindDevice(name) {
        if (!name) return;
        // Still in use if a panel currently has it OR is mid-bind to it (an in-flight
        // handoff hasn't written detectDeviceName yet — without _ssPendingDeviceName we
        // would unbind the device a concurrently-binding panel is about to depend on).
        if (panels.some(p => p && (p.detectDeviceName === name || p._ssPendingDeviceName === name)))
            return;
        const key = _ssDeviceKeyByName.get(name);
        _ssDeviceKeyByName.delete(name);
        const audio = _ssAudio();
        if (key != null && audio && typeof audio.unbindInputDevice === 'function') {
            // Register the unbind in the release barrier BEFORE awaiting, so a quick
            // switch back to this device (its key is now free) waits for the old
            // unbind to finish instead of rebinding the key and then having the late
            // unbind tear the fresh binding down (the A→B→A race).
            const p = Promise.resolve(audio.unbindInputDevice(key)).catch(() => {});
            _ssDeviceReleaseBarrier = Promise.allSettled([_ssDeviceReleaseBarrier, p]);
            await p;
        }
    }

    let active = false;
    let controlsHidden = false;
    let layout = localStorage.getItem('splitscreenLayout') || 'top-bottom';
    let alwaysSplit = localStorage.getItem('splitscreenAlwaysSplit') === 'true';
    let panels = [];       // { hw, canvas, ws, arrIndex, controls }
    let wrap = null;
    let currentFilename = null;
    let arrangements = []; // arrangement list from song_info
    let vizPlugins   = []; // {id, name, ...} — type=visualization plugins from /api/plugins
    let _starting    = false; // re-entrancy guard for startSplitScreen
    let _pendingRebuild = false; // rebuildLayout requested while a start is in flight
    // Redock requests ({popupId, finalState}) that arrived while a start was in
    // flight — drained in startSplitScreen()'s finally, same pattern as
    // _pendingRebuild. Without this a popup's `docked` message landing during
    // the post-pop-out rebuild would teardown the half-built layout mid-flight.
    let _pendingRedocks = [];

    // Core swaps a panel's <canvas> element when a renderer needs a different
    // context type than the one the canvas is bound to (browsers lock a canvas
    // to its first getContext type) — e.g. installing 3D Highway (webgl2) on a
    // freshly-2D canvas. After the swap our panel.canvas points at the detached
    // old element, so every later hw.resize() (bar toggle, window resize,
    // layout change) writes geometry to a dead node and the live canvas stays
    // frozen at its init-time size — leaving an empty strip at the panel bottom.
    // Re-bind to the new element and re-fit. Registered once; harmless when no
    // panel owns the swapped canvas (e.g. the main-player highway swapping).
    if (window.slopsmith && typeof window.slopsmith.on === 'function') {
        window.slopsmith.on('highway:canvas-replaced', (e) => {
            const d = e && e.detail;
            if (!d || !d.oldCanvas || !d.newCanvas) return;
            const p = panels.find((pp) => pp.canvas === d.oldCanvas);
            if (!p) return;
            p.canvas = d.newCanvas;
            try { p.hw.resize(); } catch (_) { /* highway may be mid-teardown */ }
        });

        // Broadcast song changes to any popped-out follower windows. This
        // used to live inside the post-`await _play()` `_onReady` callback
        // in our playSong wrapper, but an upstream wrapper that throws
        // (capo's _capoInjectBadge has been seen failing in v3) would
        // skip the entire post-await block — popups stayed stuck on the
        // old chart and the song-change toast never appeared. core's
        // `song:ready` event fires from highway.js directly on the WS
        // `ready` message, independent of any wrapper, so subscribing
        // here keeps the broadcast firing even when the wrapper chain
        // throws. The popup's `currentFilename !== msg.filename` guard
        // already absorbs the no-op case (initial pop-out, where popup
        // and main agree on the song).
        window.slopsmith.on('song:ready', () => {
            if (FOLLOWER) return;
            if (typeof ssChannel === 'undefined' || !ssChannel) return;
            if (!popups || popups.size === 0) return;
            if (!currentFilename) return;
            try { ssChannel.postMessage({ type: 'song-changed', filename: currentFilename }); }
            catch (e) { console.warn('[splitscreen] song-changed broadcast failed:', e); }
        });
    }

    // Focus model — which panel currently "owns" multi-instance plugin
    // resources (MIDI input routing for piano, settings-gear placement, etc).
    // Defaults to panel 0; clicking another panel transfers focus.
    let focusedPanelIdx = 0;
    const focusListeners = new Set();
    function _focusedPanel() {
        if (!active || !panels.length) return null;
        if (focusedPanelIdx >= panels.length) focusedPanelIdx = 0;
        return panels[focusedPanelIdx];
    }
    function _emitFocusChange() {
        for (const fn of focusListeners) {
            try { fn(); } catch (_) { /* listener errors must not break peers */ }
        }
    }
    function _applyFocusBorder() {
        for (let i = 0; i < panels.length; i++) {
            panels[i].panelDiv.style.borderColor = i === focusedPanelIdx ? '#4080e0' : '#333';
        }
    }
    function _setFocusedPanel(idx) {
        if (idx < 0 || idx >= panels.length) return;
        if (idx === focusedPanelIdx) return;
        focusedPanelIdx = idx;
        _applyFocusBorder();
        _emitFocusChange();
    }
    function _findPanelIdxByCanvas(canvas) {
        if (!canvas) return -1;
        for (let i = 0; i < panels.length; i++) {
            if (panels[i].canvas === canvas) return i;
        }
        return -1;
    }

    // Viz factory globals were renamed `window.slopsmithViz_<id>` ->
    // `window.feedBackViz_<id>` in the feedBack rename (core's main-player picker
    // and highway_3d register under the new name; core keeps the legacy name as a
    // compat shim for third-party viz). Resolve BOTH so the per-panel picker finds
    // a viz whether it registered under the new or the legacy global — otherwise a
    // migrated viz (e.g. highway_3d) never shows up here.
    const VIZ_FACTORY_PREFIXES = ['feedBackViz_', 'slopsmithViz_'];
    function vizFactory(id) {
        for (let i = 0; i < VIZ_FACTORY_PREFIXES.length; i++) {
            const f = window[VIZ_FACTORY_PREFIXES[i] + id];
            if (typeof f === 'function') return f;
        }
        return undefined;
    }
    function hasVizFactory(id) { return typeof vizFactory(id) === 'function'; }

    let _vizPluginsFetchFailed = false;
    async function fetchVizPlugins() {
        try {
            const resp = await fetch('/api/plugins');
            const all  = await resp.json();
            // Store metadata for all viz plugins; factory presence is checked at
            // populateSelect() time (not at fetch time), so the window['slopsmithViz_*']
            // globals are evaluated when the dropdown is first built.
            vizPlugins = (all || []).filter(p => p?.type === 'visualization');
        } catch (_) {
            // /api/plugins unavailable — fall back to scanning window for any
            // slopsmithViz_* factories that are already loaded so viz options
            // remain available even when the plugin registry can't be fetched.
            // Mark fetch as failed so populateSelect re-scans on every build,
            // preserving the "deferred plugin scripts are reflected" property
            // even without a registry endpoint.
            _vizPluginsFetchFailed = true;
            _rescanVizPluginsFromWindow();
        }
    }
    function _rescanVizPluginsFromWindow() {
        const seen = new Set();
        const found = [];
        Object.keys(window).forEach(k => {
            for (let i = 0; i < VIZ_FACTORY_PREFIXES.length; i++) {
                const pfx = VIZ_FACTORY_PREFIXES[i];
                if (k.startsWith(pfx) && typeof window[k] === 'function') {
                    const id = k.slice(pfx.length);
                    if (!seen.has(id)) { seen.add(id); found.push({ id, name: id }); }
                    break;
                }
            }
        });
        vizPlugins = found;
    }

    // Bounded poll for viz factories that register AFTER the picker is
    // first built. /api/plugins returns metadata for every type:visualization
    // plugin immediately, but each plugin's window.slopsmithViz_<id> factory
    // only exists after the host has loaded and executed that plugin's
    // screen.js. The host loads plugin scripts sequentially in loadPlugins()
    // (alphabetical by directory). Two cases leave the picker missing
    // entries when populateSelect() runs:
    //   - Plugins alphabetically after 'splitscreen' (tab_view, tuner, …)
    //     simply haven't been loaded yet when our IIFE runs.
    //   - Async plugins (e.g. highway_3d's `await import(CDN)` for Three.js)
    //     register their factory after their <script> onload fires, so even
    //     an alphabetically-earlier plugin can lag.
    // Without this watch, the picker stays incomplete until the user
    // triggers another populateSelect (song change, layout change) — which
    // is exactly why "split-then-unsplit in the popup" used to be the only
    // way to surface the missing viz options.
    const _seenVizFactoryIds = new Set();
    let _vizFactoryWatchTimer = null;
    function _startVizFactoryWatch() {
        if (_vizFactoryWatchTimer) return;
        // Seed with factories already present so the first tick only fires
        // on factories that appear AFTER we start watching.
        vizPlugins.forEach(vp => {
            if (hasVizFactory(vp.id)) {
                _seenVizFactoryIds.add(vp.id);
            }
        });
        const INTERVAL_MS = 200;
        const MAX_TICKS = 60;       // ~12 s — covers slow async plugins
        let ticks = 0;
        _vizFactoryWatchTimer = setInterval(() => {
            ticks++;
            let added = false;
            vizPlugins.forEach(vp => {
                if (!_seenVizFactoryIds.has(vp.id) && hasVizFactory(vp.id)) {
                    _seenVizFactoryIds.add(vp.id);
                    added = true;
                }
            });
            if (added) {
                // Re-populate every live panel's picker so the new viz
                // options become available. populateSelect honours each
                // panel's vizMode / lyricsMode / jumpingTabMode + arrIndex,
                // so the user's current selection is preserved across the
                // rebuild.
                panels.forEach(p => {
                    if (p && p.select) populateSelect(p, p.arrIndex || 0);
                });
            }
            const allPresent = vizPlugins.every(vp => hasVizFactory(vp.id));
            if (allPresent || ticks >= MAX_TICKS) {
                clearInterval(_vizFactoryWatchTimer);
                _vizFactoryWatchTimer = null;
            }
        }, INTERVAL_MS);
    }

    // Keep the promise so startSplitScreen / loadSongInFollower can await it —
    // panels are never populated before the list is ready even on a fast first
    // interaction.
    const _vizPluginsReady = fetchVizPlugins();

    // ══════════════════════════════════════════════════════════════════════
    //  Pop-out / follower-mode (multi-monitor support).
    //
    //  When the user clicks "Pop Out" on a panel in the main window, we open
    //  this same slopsmith app in a new browser window with `ssFollower=1`
    //  and a serialized panel config in URL params. The popup boots normally
    //  (loads app.js + all plugins) but the splitscreen IIFE detects the
    //  follower flag and instead of running the usual auto-Split UI, it
    //  builds a single full-window panel slaved to the main window's audio
    //  via BroadcastChannel('slopsmith-ss').
    //
    //  popups: in the main window, tracks every popup we've spawned so we
    //  can re-instate the panel when the popup posts a `docked` message.
    //  Keyed by popupId. Entry: { popup, originalConfig } — `popup` is the
    //  window handle (so the broadcaster can reap a popup that died without
    //  firing beforeunload); `originalConfig` is the panel state at pop-out time.
    //
    //  FOLLOWER: parsed once on script load. Truthy in the popup window
    //  only. Carries the panel config received from the opener.
    // ══════════════════════════════════════════════════════════════════════
    const popups = new Map();
    const FOLLOWER = (function () {
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('ssFollower') !== '1') return null;
            const cfg = {
                popupId:       params.get('popupId') || '',
                filename:      params.get('filename') || '',
                arrangement:   parseInt(params.get('arrangement'), 10) || 0,
                mode:          params.get('mode') || '2d',
                inverted:      params.get('inverted') === '1',
                lefty:         params.get('lefty') === '1',
                mastery:       parseFloat(params.get('mastery')),
                // User-driven per-panel toggles forwarded by the spawning
                // window so the popup mirrors the source panel's state.
                lyrics:        params.get('lyrics') === '1',
                barHidden:     params.get('barHidden') === '1',
                detectChannel: params.get('detectChannel') || 'mono',
                detectDeviceName: params.get('detectDeviceName') || '',
                detectVerifierOffsetMs: parseFloat(params.get('detectVerifierOffsetMs')) || 0,
            };
            if (!cfg.filename) return null;
            return cfg;
        } catch (_) {
            return null;
        }
    })();
    const SS_CHANNEL_NAME = 'slopsmith-ss';
    let ssChannel = null;       // shared BroadcastChannel (lazily opened)
    function _ssChannel() {
        if (!ssChannel && typeof BroadcastChannel === 'function') {
            ssChannel = new BroadcastChannel(SS_CHANNEL_NAME);
        }
        return ssChannel;
    }

    // Public API for plugins that want per-panel state (e.g. 3D Highway reads
    // its per-panel palette/background settings via localStorage keys keyed
    // by panel index, and calls panelIndexFor(canvas) to resolve which panel
    // a canvas belongs to).
    window.slopsmithSplitscreen = {
        // Active state — false during normal main-player operation. Plugins
        // gate their splitscreen-aware code paths on this so they fall back
        // to the single-instance main-player path when the user isn't split.
        isActive() { return active; },

        // Identify a panel by the highway canvas its renderer received in init().
        panelIndexFor(canvas) {
            if (!active) return null;
            const i = _findPanelIdxByCanvas(canvas);
            return i === -1 ? null : i;
        },

        // Container element for per-panel chrome/overlays. Plugins that mount
        // their own DOM (piano overlay canvas, drums HUD) anchor against this
        // so the overlay sizes to the panel rect, not the whole #player.
        panelChromeFor(canvas) {
            if (!active) return null;
            const i = _findPanelIdxByCanvas(canvas);
            return i === -1 ? null : panels[i].panelDiv;
        },

        // Anchor for per-panel settings buttons (e.g. piano gear button).
        // The mini control bar is the natural place — already visible, already
        // panel-scoped, already used for invert/lyrics/tab/detect toggles.
        settingsAnchorFor(canvas) {
            if (!active) return null;
            const i = _findPanelIdxByCanvas(canvas);
            return i === -1 ? null : panels[i].bar;
        },

        // True when this canvas's panel is the focused one. Plugins use this
        // to route shared input (e.g. MIDI keyboard) to a single instance.
        isCanvasFocused(canvas) {
            if (!active) return true; // no panels => main-player single instance
            const i = _findPanelIdxByCanvas(canvas);
            if (i === -1) return false;
            if (focusedPanelIdx >= panels.length) focusedPanelIdx = 0;
            return i === focusedPanelIdx;
        },

        onFocusChange(fn) {
            if (typeof fn === 'function') focusListeners.add(fn);
        },
        offFocusChange(fn) {
            focusListeners.delete(fn);
        },
    };

    // 3D Highway palette IDs. Mirrors the PALETTES registry in the 3dhighway
    // plugin's screen.js — kept as a plain list here to avoid a runtime
    // dependency on the plugin being loaded.
    const H3D_PALETTES = [
        { id: 'default', label: 'Default' },
        { id: 'neon',    label: 'Neon' },
        { id: 'pastel',  label: 'Pastel' },
    ];

    // Per-panel viz controls surfaced in a panel's "3D ⚙" popover. Each entry:
    //   { key, label, type:'toggle'|'range'|'select', default, min?, max?, step?, options? }
    // `key` is the localStorage suffix the viz plugin reads per-panel. For
    // highway_3d that's h3d_bg_panel<N>_<key>, falling back to the global
    // h3d_bg_<key> (see the plugin's _bgReadSetting). A viz plugin can override
    // this list at runtime by exposing `window.slopsmithViz_highway_3d.panelControls`
    // (same shape) — that takes precedence so the plugin owns the up-to-date
    // list without splitscreen needing edits when it adds options.
    // For `range`: min/max default to 0..1 and step to 0.05 when omitted.
    const VIZ_PANEL_CONTROLS = {
        highway_3d: [
            { key: 'palette',         label: 'Palette',                  type: 'select', default: 'default', options: H3D_PALETTES },
            { key: 'cameraSmoothing', label: 'Camera smoothing (X-pan)', type: 'range',  default: 0.5, min: 0, max: 1, step: 0.05 },
            { key: 'cameraLockLow',   label: 'Lock camera at frets 1–12',type: 'toggle', default: false },
            { key: 'cameraLockZoom',  label: 'Locked zoom (In ↔ Out)',   type: 'range',  default: 0.5, min: 0, max: 1, step: 0.05 },
        ],
    };
    // Range-control bounds with defaults (min/max/step are optional in the descriptor).
    function _ctlRange(ctl) {
        return {
            lo: Number.isFinite(ctl.min) ? ctl.min : 0,
            hi: Number.isFinite(ctl.max) ? ctl.max : 1,
            st: Number.isFinite(ctl.step) ? ctl.step : 0.05,
        };
    }
    function getPanelControlsFor(pluginId) {
        // v1: only highway_3d is wired — _vizPanelGet/_vizPanelSet use its
        // localStorage scheme (h3d_bg_panel<N>_<key>) and its window.h3dBgSet*
        // setters. The popover stays hidden for other viz plugins until the
        // descriptor carries per-plugin storage/setter info (or read/write fns).
        // A plugin can still customize *which* controls show via
        // window.slopsmithViz_highway_3d.panelControls.
        if (pluginId !== 'highway_3d') return null;
        const fac = vizFactory(pluginId);
        // An array (even empty) is an intentional override — empty = opt out of
        // per-panel controls. _showVizControls hides the button on an empty list.
        if (fac && Array.isArray(fac.panelControls)) return fac.panelControls;
        return VIZ_PANEL_CONTROLS[pluginId] || null;
    }

    // ── Settings sync ──
    const layoutSelect = document.getElementById('splitscreen-default-layout');
    if (layoutSelect) {
        layoutSelect.value = layout;
        layoutSelect.addEventListener('change', () => {
            layout = layoutSelect.value;
            localStorage.setItem('splitscreenLayout', layout);
            if (active) rebuildLayout();
        });
    }

    const alwaysSplitCheckbox = document.getElementById('splitscreen-always-split');
    if (alwaysSplitCheckbox) {
        alwaysSplitCheckbox.checked = alwaysSplit;
        alwaysSplitCheckbox.addEventListener('change', () => {
            alwaysSplit = alwaysSplitCheckbox.checked;
            localStorage.setItem('splitscreenAlwaysSplit', alwaysSplit);
        });
    }

    // ── Panel preference persistence ──
    // Snapshot a live panel into the splitscreenPanelPrefs entry shape. Mode is
    // encoded into arrName (LYRICS_VALUE / JUMPING_TAB_VALUE:<arr> /
    // VIZ_PREFIX:<id>:<arr> / plain arrangement name). Single source of truth
    // for the encoding — used by savePanelPrefs (persist to localStorage),
    // captureCurrentPrefs (in-memory, for rebuildLayout / _redockPanel) and
    // popOutPanel (snapshot of the panels left behind). Keep all three on this
    // helper so a new per-panel field is added once, not three times.
    function panelToPrefs(p) {
        return {
            arrName: p.jumpingTabMode
                ? JUMPING_TAB_VALUE + ':' + (arrangements[p.arrIndex]?.name || '')
                : p.vizMode
                ? VIZ_PREFIX + ':' + p.vizMode + ':' + (arrangements[p.arrIndex]?.name || '')
                : p.lyricsMode ? LYRICS_VALUE : (arrangements[p.arrIndex]?.name || ''),
            lyrics: !!p.lyricsOverlayOn,
            inverted: p.hw.getInverted(),
            lefty: p.hw.getLefty(),
            detectChannel: p.detectChannel || 'mono',
            detectDeviceName: p.detectDeviceName || '',
            detectVerifierOffsetMs: p.detectVerifierOffsetMs || 0,
            barHidden: p.bar.style.display === 'none',
            mastery: p.hw.getMastery(),
        };
    }
    function savePanelPrefs() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(panels.map(panelToPrefs)));
    }

    function loadPanelPrefs() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null;
        } catch (_) {
            return null;
        }
    }

    // Migration version marker so one-time resets (e.g. the lyrics-overlay
    // semantics flip) only run on prefs written by older code. Without this
    // gate, a per-load migration would clobber the user's actual toggle
    // state every reload — the overlay-on choice could never persist.
    const PREFS_MIGRATION_KEY = 'splitscreenPrefsMigrationV';
    const PREFS_CURRENT_V = 2;

    function migratePanelPrefs(prefs) {
        if (!Array.isArray(prefs)) return prefs;
        let v = 0;
        try { v = parseInt(localStorage.getItem(PREFS_MIGRATION_KEY) || '0', 10) || 0; }
        catch (_) {}
        const needsLyricsReset = v < 2;
        const out = prefs.map(p => {
            const next = { ...p };
            // v < 2: previous `lyrics` field tracked highway's built-in
            // setLyricsVisible (defaulted to true). The new overlay-driven
            // toggle inherits that field, so existing users would otherwise
            // see overlay-on everywhere on first load. Reset once; from then
            // on the user-driven value round-trips normally.
            if (needsLyricsReset) next.lyrics = false;
            // Legacy 3D-Highway sentinel migration (pre-PR-36).
            if (next.arrName?.startsWith('__3d_highway__:')) {
                next.arrName = VIZ_PREFIX + ':highway_3d:' + next.arrName.slice('__3d_highway__:'.length);
            }
            return next;
        });
        if (v < PREFS_CURRENT_V) {
            try { localStorage.setItem(PREFS_MIGRATION_KEY, String(PREFS_CURRENT_V)); }
            catch (_) {}
        }
        return out;
    }

    function resolveArrIndex(arrName) {
        if (!arrName || arrName === LYRICS_VALUE || arrName.startsWith(JUMPING_TAB_VALUE) || arrName.startsWith(VIZ_PREFIX + ':')) return -1;
        const lower = arrName.toLowerCase();
        for (let i = 0; i < arrangements.length; i++) {
            if ((arrangements[i].name || '').toLowerCase() === lower) return i;
        }
        return -1;
    }

    // ── Helpers ──
    function getWsUrl(filename, arrangement) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const arrParam = arrangement !== undefined ? `?arrangement=${arrangement}` : '';
        // Match core highway.js (`decodeURIComponent(filename)` before
        // building the WS URL — static/highway.js:3575). v3's songs.js
        // calls `playSong(encodeURIComponent(localFilename))`, so
        // `currentFilename` carries percent-encoded path separators
        // (e.g. `sloppak%2Fperfouts.sloppak`). FastAPI's path-parameter
        // router does NOT decode `%2F` into `/`, so the encoded form
        // misses the route and the server returns "File not found",
        // closing every panel WS instantly. Decode here to match the
        // contract the rest of splitscreen already documents (CLAUDE.md
        // "getWsUrl() handles this internally for highway connections").
        //
        // `currentFilename` is always the ENCODED form in both v2 and v3 — the
        // grid renders `data-play="<encodeURIComponent(localFilename)>"`
        // (app.js), v3's songs.js calls `playSong(enc(localFilename))`, and
        // app.js's `player.start()` normalizes any raw name to the encoded
        // form before calling playSong. So a single unconditional decode here
        // mirrors core highway.js:3575 exactly and never sees a raw or
        // malformed `%` (no try/catch needed — core doesn't guard it either).
        const decoded = decodeURIComponent(filename);
        return `${proto}//${location.host}/ws/highway/${decoded}${arrParam}`;
    }

    function getDefaultArrangements(count) {
        // Assign arrangements intelligently: lead, rhythm, bass, then wrap
        const defaults = [];
        const byName = {};
        arrangements.forEach((a, i) => {
            const n = (a.name || '').toLowerCase();
            if (n.includes('lead') && !byName.lead) byName.lead = i;
            else if (n.includes('rhythm') && !byName.rhythm) byName.rhythm = i;
            else if (n.includes('bass') && !byName.bass) byName.bass = i;
        });
        const order = [byName.lead, byName.rhythm, byName.bass].filter(i => i !== undefined);
        // Fill remaining with whatever's available
        for (let i = 0; i < arrangements.length; i++) {
            if (!order.includes(i)) order.push(i);
        }
        for (let i = 0; i < count; i++) {
            defaults.push(order[i % order.length]);
        }
        return defaults;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Lyrics-only pane renderer
    // ══════════════════════════════════════════════════════════════════════

    function createLyricsPane(container, opts) {
        const overlay = !!(opts && opts.overlay);
        const el = document.createElement('div');
        el.className = overlay ? 'splitscreen-lyrics-overlay' : 'splitscreen-lyrics-pane';
        // Overlay mode: top-anchored translucent band that floats above
        // whatever renderer owns the canvas (default 2D, piano, drums, 3D
        // Highway, ...). z-index 9 sits above bar (7) and barToggleBtn (8)
        // so lyrics are always on top regardless of viz. pointer-events:none
        // so toggles/clicks under it (including the canvas) still work.
        // Full-pane mode: opaque, fills the panel — used for lyrics-only
        // mode (canvas hidden), unchanged from before.
        el.style.cssText = overlay
            ? 'position:absolute;top:0;left:0;right:0;height:auto;' +
              'display:flex;flex-direction:column;justify-content:center;align-items:center;' +
              'background:rgba(8,8,16,0.78);padding:10px 16px;overflow:hidden;' +
              'pointer-events:none;z-index:9;'
            : 'position:absolute;top:0;left:0;right:0;bottom:0;' +
              'display:flex;flex-direction:column;justify-content:center;align-items:center;' +
              'background:#08080e;padding:24px;overflow:hidden;';
        container.appendChild(el);

        let lyrics = [];
        let lines = null;
        let ws = null;
        let raf = null;

        function parseLyrics(data) {
            lyrics = data;
            lines = null;
            if (!lyrics.length) return;

            const result = [];
            let line = null, word = null;

            const flushWord = () => {
                if (word && word.length) line.words.push(word);
                word = null;
            };
            const flushLine = () => {
                flushWord();
                if (line && line.words.length) result.push(line);
                line = null;
            };

            for (let i = 0; i < lyrics.length; i++) {
                const l = lyrics[i];
                const raw = l.w || '';
                const endsLine = raw.endsWith('+');
                const continuesWord = raw.endsWith('-');

                if (line && i > 0) {
                    const prev = lyrics[i - 1];
                    if (l.t - (prev.t + prev.d) > 4.0) flushLine();
                }

                if (!line) line = { words: [], start: l.t, end: l.t + l.d };
                if (!word) word = [];

                word.push(l);
                line.end = Math.max(line.end, l.t + l.d);

                if (!continuesWord) flushWord();
                if (endsLine) flushLine();
            }
            flushLine();
            lines = result;
        }

        function syllableText(s) {
            const t = s.w || '';
            return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t;
        }

        function renderLine(lineData, currentTime) {
            const frag = document.createDocumentFragment();
            for (const word of lineData.words) {
                for (const syl of word) {
                    const span = document.createElement('span');
                    span.textContent = syllableText(syl);
                    const active = currentTime >= syl.t && currentTime < syl.t + syl.d;
                    const past = currentTime >= syl.t + syl.d;
                    if (active) {
                        span.style.color = '#60a0ff';
                        span.style.textShadow = '0 0 12px rgba(96,160,255,0.5)';
                    } else if (past) {
                        span.style.color = '#9ca3af';
                    } else {
                        span.style.color = '#555';
                    }
                    frag.appendChild(span);
                }
                const space = document.createDocumentFragment();
                space.appendChild(document.createTextNode(' '));
                frag.appendChild(space);
            }
            return frag;
        }

        function render() {
            raf = requestAnimationFrame(render);
            if (!lines || !lines.length) {
                if (!el.dataset.empty) {
                    el.innerHTML = '<span style="color:#555;font-style:italic">No lyrics</span>';
                    el.dataset.empty = '1';
                }
                return;
            }
            delete el.dataset.empty;

            const audio = document.getElementById('audio');
            const t = audio ? audio.currentTime : 0;

            let currentIdx = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].start <= t) currentIdx = i;
                else break;
            }
            if (currentIdx === -1) {
                if (lines[0].start - t > 3.0) {
                    el.innerHTML = '';
                    return;
                }
                currentIdx = 0;
            }

            const currentLine = lines[currentIdx];
            const nextLine = lines[currentIdx + 1] || null;
            const gapToNext = nextLine ? (nextLine.start - currentLine.end) : Infinity;

            if (t > currentLine.end + 1.0 && gapToNext > 4.0) {
                el.innerHTML = '';
                return;
            }

            el.innerHTML = '';

            const curDiv = document.createElement('div');
            curDiv.style.cssText = overlay
                ? 'font-size:clamp(14px, 2vw, 22px);font-weight:600;text-align:center;line-height:1.3;transition:opacity 0.3s;'
                : 'font-size:clamp(20px, 4vw, 48px);font-weight:600;text-align:center;line-height:1.4;transition:opacity 0.3s;';
            curDiv.appendChild(renderLine(currentLine, t));
            el.appendChild(curDiv);

            if (nextLine && gapToNext <= 4.0) {
                const nextDiv = document.createElement('div');
                nextDiv.style.cssText = overlay
                    ? 'font-size:clamp(11px, 1.5vw, 17px);font-weight:400;text-align:center;line-height:1.3;margin-top:4px;color:#444;'
                    : 'font-size:clamp(16px, 3vw, 36px);font-weight:400;text-align:center;line-height:1.4;margin-top:16px;color:#444;';
                nextDiv.appendChild(renderLine(nextLine, t));
                el.appendChild(nextDiv);
            }
        }

        function connect(filename, arrangement) {
            destroy();
            ws = new WebSocket(getWsUrl(filename, arrangement));
            ws.onmessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'lyrics') parseLyrics(msg.data);
            };
            ws.onerror = () => {};
            ws.onclose = () => { ws = null; };
            raf = requestAnimationFrame(render);
        }

        function destroy() {
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            if (ws) { ws.close(); ws = null; }
            lyrics = [];
            lines = null;
            el.innerHTML = '';
        }

        return { el, connect, destroy };
    }

    // ══════════════════════════════════════════════════════════════════════

    // ── Layout ──
    function createWrap() {
        if (wrap) wrap.remove();
        const player = document.getElementById('player');
        wrap = document.createElement('div');
        wrap.id = 'splitscreen-wrap';
        // The wrap is position:absolute relative to #player, so it must be a
        // direct child of #player. Anchor it before the bottom chrome. Core
        // (slopsmith#719) wraps #player-controls in a #player-footer div, so
        // #player-controls is no longer a direct child of #player — using it as
        // the insertBefore reference throws NotFoundError. Prefer #player-footer
        // (the current direct child), fall back to #player-controls for older
        // cores where it's still a direct child, else just append.
        const footer = document.getElementById('player-footer');
        const controls = document.getElementById('player-controls');
        const anchor = [footer, controls].find(el => el && el.parentNode === player);
        if (anchor) player.insertBefore(wrap, anchor);
        else player.appendChild(wrap);
        return wrap;
    }

    function applyLayoutStyle(container, layoutKey) {
        // Note: bottom is set dynamically by sizeCanvases() to leave room for global controls
        container.style.cssText =
            'position:absolute;top:0;left:0;right:0;z-index:3;display:flex;';
        if (layoutKey === 'top-bottom') {
            container.style.flexDirection = 'column';
        } else if (layoutKey === 'left-right') {
            container.style.flexDirection = 'row';
        } else {
            container.style.flexDirection = 'row';
            container.style.flexWrap = 'wrap';
        }
    }

    function createPanel(index, container, layoutKey) {
        const panelDiv = document.createElement('div');
        panelDiv.className = 'splitscreen-panel';
        panelDiv.style.cssText = 'position:relative;overflow:hidden;box-sizing:border-box;border:1px solid #333;';

        if (layoutKey === 'quad') {
            panelDiv.style.width = '50%';
            panelDiv.style.height = '50%';
        } else if (layoutKey === 'left-right') {
            panelDiv.style.width = '50%';
            panelDiv.style.height = '100%';
        } else if (layoutKey === 'tri-top') {
            panelDiv.style.width = index === 0 ? '100%' : '50%';
            panelDiv.style.height = '50%';
        } else if (layoutKey === 'tri-bottom') {
            panelDiv.style.width = index === 2 ? '100%' : '50%';
            panelDiv.style.height = '50%';
        } else if (layoutKey === 'follower') {
            panelDiv.style.width = '100%';
            panelDiv.style.height = '100%';
        } else {
            panelDiv.style.width = '100%';
            panelDiv.style.height = '50%';
        }

        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:100%;height:100%;display:block;';
        panelDiv.appendChild(canvas);

        // Mini control bar
        const bar = document.createElement('div');
        bar.style.cssText =
            'position:absolute;bottom:0;left:0;right:0;' +
            'display:flex;align-items:center;gap:10px;padding:4px 8px;' +
            'flex-wrap:nowrap;overflow:hidden;' +
            // Opaque (not rgba .85) so nothing rendering behind #splitscreen-wrap
            // — e.g. a stale full-screen viz overlay — can bleed through the bar.
            'background:#08080e;z-index:7;';

        // Panel label
        const label = document.createElement('span');
        label.style.cssText = 'font-size:11px;color:#888;font-weight:bold;min-width:16px;';
        label.textContent = `P${index + 1}`;
        bar.appendChild(label);

        // Arrangement selector
        const select = document.createElement('select');
        select.style.cssText =
            'background:#1a1a2e;border:1px solid #333;border-radius:4px;' +
            'padding:2px 4px;font-size:11px;color:#ccc;outline:none;max-width:120px;';
        bar.appendChild(select);

        // Arrangement name display
        const arrName = document.createElement('span');
        arrName.style.cssText = 'font-size:11px;color:#6b7280;';
        bar.appendChild(arrName);

        const makeToggleBtn = (label, marginLeft) => {
            const b = document.createElement('button');
            b.style.cssText =
                (marginLeft ? 'margin-left:' + marginLeft + ';' : '') +
                'padding:2px 8px;border-radius:4px;font-size:10px;' +
                'border:1px solid #333;cursor:pointer;background:#1a1a2e;color:#9ca3af;';
            b.textContent = label;
            return b;
        };
        const styleToggle = (btn, on, onColor) => {
            btn.style.background = on ? onColor : '#1a1a2e';
            btn.style.color = on ? '#fff' : '#9ca3af';
        };

        const invertBtn = makeToggleBtn('Invert');
        const updateInvertStyle = (on) => styleToggle(invertBtn, on, '#4c1d95');
        updateInvertStyle(false);
        bar.appendChild(invertBtn);

        const leftyBtn = makeToggleBtn('Lefty');
        const updateLeftyStyle = (on) => styleToggle(leftyBtn, on, '#166534');
        updateLeftyStyle(false);
        bar.appendChild(leftyBtn);

        const lyricsBtn = makeToggleBtn('Lyrics');
        const updateLyricsStyle = (on) => styleToggle(lyricsBtn, on, '#065f46');
        bar.appendChild(lyricsBtn);

        const tabBtn = makeToggleBtn('Tab');
        const updateTabStyle = (on) => styleToggle(tabBtn, on, '#1e40af');
        updateTabStyle(false);
        bar.appendChild(tabBtn);

        const detectBtn = makeToggleBtn('Detect');
        const updateDetectStyle = (on) => styleToggle(detectBtn, on, '#14532d');
        updateDetectStyle(false);
        bar.appendChild(detectBtn);

        const channelBtn = makeToggleBtn('M');
        channelBtn.title = 'Audio channel (cycle): Mono / input channel number';
        bar.appendChild(channelBtn);

        // Per-panel input DEVICE picker (desktop multi-device). "Main" = the
        // engine's primary input device (deviceKey 0); other entries bind an
        // ADDITIONAL physical interface so two panels can score two separate
        // cables independently. Hidden unless the desktop bridge supports it
        // (populated in wireDetectControls); the channel button then selects a
        // channel WITHIN the chosen device.
        const deviceSelect = document.createElement('select');
        deviceSelect.style.cssText = select.style.cssText;
        deviceSelect.title = 'Input device for detection';
        deviceSelect.innerHTML = '<option value="">Main</option>';
        deviceSelect.style.display = 'none';
        bar.appendChild(deviceSelect);

        // Per-panel capture-latency nudge for an extra device. An extra interface's
        // audio reaches the engine at a different time than the primary's, throwing
        // off scoring timing — the user dials this until notes register on the beat
        // (watch the score peak). Hidden unless the device picker is available; only
        // meaningful for a non-Main device. ±5 ms steps.
        const latWrap = document.createElement('span');
        latWrap.style.cssText = 'display:none;align-items:center;gap:1px;font-size:10px;color:#9ca3af;margin-left:2px;';
        latWrap.title = 'Detection timing offset for this input (ms) — nudge until notes land on the beat';
        const latDown = makeToggleBtn('−');
        const latVal = document.createElement('span');
        latVal.style.cssText = 'min-width:38px;text-align:center;';
        latVal.textContent = '0ms';
        const latUp = makeToggleBtn('+');
        latWrap.appendChild(latDown); latWrap.appendChild(latVal); latWrap.appendChild(latUp);
        bar.appendChild(latWrap);

        // "3D ⚙" — per-panel viz settings. Hidden unless the panel is running
        // a viz plugin that declares panel controls (see getPanelControlsFor).
        // Opens vizPopover (below); the controls inside are generated from the
        // descriptor, so new per-panel options need no change here.
        const vizSettingsBtn = makeToggleBtn('3D ⚙');
        vizSettingsBtn.title = 'Per-panel viz settings';
        vizSettingsBtn.style.display = 'none';
        vizSettingsBtn.setAttribute('data-ss-viz-btn', '');
        bar.appendChild(vizSettingsBtn);

        const masteryHeading = document.createElement('span');
        masteryHeading.style.cssText = 'font-size:10px;color:#6b7280;white-space:nowrap;';
        masteryHeading.textContent = 'Difficulty';
        bar.appendChild(masteryHeading);

        const masterySlider = document.createElement('input');
        masterySlider.type = 'range';
        masterySlider.min = '0';
        masterySlider.max = '100';
        masterySlider.step = '5';
        masterySlider.value = '100';
        masterySlider.disabled = true;
        masterySlider.style.cssText = 'width:52px;accent-color:#4080e0;cursor:not-allowed;opacity:0.4;';
        masterySlider.title = 'Master difficulty (requires multi-level chart)';
        bar.appendChild(masterySlider);

        const masteryLabel = document.createElement('span');
        masteryLabel.style.cssText = 'font-size:10px;color:#6b7280;min-width:26px;';
        masteryLabel.textContent = '—';
        bar.appendChild(masteryLabel);

        // Pop Out / Dock — visibility flips by mode (FOLLOWER => Dock; main => Pop Out).
        // The actual click handlers are wired in initPanel() so they have access
        // to the panel object via closure. We append at the end of the bar
        // (no `margin-left:auto` because barToggleBtn lives absolute-positioned
        // at bottom:0;right:0 and the auto-margin would collide with it).
        const popOutBtn = document.createElement('button');
        popOutBtn.style.cssText =
            'padding:2px 6px;border-radius:4px;font-size:10px;' +
            'border:1px solid #333;cursor:pointer;background:#1a1a2e;color:#9ca3af;' +
            'white-space:nowrap;';
        if (FOLLOWER) {
            popOutBtn.textContent = '⇲ Dock';
            popOutBtn.title = 'Return this panel to the main window';
        } else {
            popOutBtn.textContent = '⇱ Pop';
            popOutBtn.title = 'Open this panel in a new window';
        }
        bar.appendChild(popOutBtn);

        panelDiv.appendChild(bar);

        // Per-panel viz settings popover (filled lazily by buildVizPopover).
        // Anchored above the bar's right edge. pointer-events default so the
        // controls inside work; the panel's overflow:hidden clips it to the
        // panel — fine since it's small and sits at the bottom-right.
        const vizPopover = document.createElement('div');
        vizPopover.className = 'ss-viz-popover';
        vizPopover.style.cssText =
            'position:absolute;right:4px;bottom:' + ((bar.offsetHeight || 28) + 4) + 'px;z-index:9;' +
            'display:none;background:rgba(8,8,16,0.97);border:1px solid #333;border-radius:6px;' +
            'padding:8px 10px;max-width:260px;box-shadow:0 4px 16px rgba(0,0,0,0.5);';
        panelDiv.appendChild(vizPopover);
        vizSettingsBtn.onclick = (e) => {
            e.stopPropagation();
            const open = vizPopover.style.display === 'none';
            _closeAllVizPopovers();
            if (open) {
                // Rebuild from current localStorage so the controls aren't
                // stale — global or per-panel h3d_bg_* keys may have changed
                // (e.g. via the plugin's settings UI) while the popover was
                // closed. _closeAllVizPopovers / the outside-click handler
                // only hide; they don't empty, so a rebuild here is the
                // single point that guarantees fresh values.
                const p = panels.find(pp => pp.panelDiv === panelDiv);
                if (p && p.vizMode) buildVizPopover(p, p.vizMode);
                // Re-anchor in case the bar height changed since creation.
                vizPopover.style.bottom = ((bar.offsetHeight || 28) + 4) + 'px';
                vizPopover.style.display = '';
            }
        };

        const barToggleBtn = document.createElement('button');
        barToggleBtn.style.cssText =
            'position:absolute;bottom:0;right:0;z-index:8;' +
            'display:flex;align-items:center;justify-content:center;' +
            'padding:2px 6px;border-radius:4px 0 0 0;cursor:pointer;' +
            'background:rgba(64,128,224,0.85);border:none;' +
            'font-size:10px;color:#fff;line-height:1;';
        barToggleBtn.textContent = '▾ Bar';
        barToggleBtn.title = 'Hide panel controls';
        panelDiv.appendChild(barToggleBtn);

        // Click-to-focus. Pointerdown (capture) so it fires before any inner
        // control swallows the event. Resolves the panel by index at fire
        // time — `panels` is rebuilt by rebuildLayout, so the closure can't
        // capture a stable panel reference here.
        panelDiv.addEventListener('pointerdown', () => {
            const i = panels.findIndex(p => p.panelDiv === panelDiv);
            if (i !== -1) _setFocusedPanel(i);
        }, true);

        container.appendChild(panelDiv);

        return {
            panelDiv, canvas, bar, barToggleBtn, select, arrName,
            invertBtn, updateInvertStyle,
            leftyBtn, updateLeftyStyle,
            lyricsBtn, updateLyricsStyle,
            tabBtn, updateTabStyle,
            detectBtn, updateDetectStyle,
            channelBtn, deviceSelect, latWrap, latVal, latDown, latUp,
            vizSettingsBtn, vizPopover,
            masteryHeading, masterySlider, masteryLabel,
            popOutBtn,
        };
    }

    function sizeCanvases() {
        if (!wrap || !panels.length) return;
        // Bottom chrome is #player-footer (wraps #player-controls + the Section
        // Practice bar) on current cores; fall back to #player-controls alone on
        // older cores that have no footer wrapper.
        const footer = document.getElementById('player-footer');
        const controls = document.getElementById('player-controls');
        const controlsH = (footer || controls) ? (footer || controls).offsetHeight : 50;
        // Make room for top-anchored siblings inside #player (e.g. the Section
        // Map plugin's bar at top:0 z-index:5) so panels don't render under them.
        const sm = document.getElementById('section-map');
        const topOffset = sm ? sm.offsetHeight : 0;
        wrap.style.top = topOffset + 'px';
        wrap.style.bottom = controlsH + 'px';
        for (const p of panels) {
            if (p.jumpingTabMode && p.jumpingTabPane) {
                p.jumpingTabPane.resize();
            } else if (!p.lyricsMode) {
                p.hw.resize();
            }
        }
    }

    // ── Highway re-creation (fixes issue #22: charts mix on mid-song arrangement switch) ──
    // hw.reconnect() / hw.connect() in core close+reopen the WS, but the OLD WS's
    // onmessage handler is bound with a closure that still references the same
    // outer-scope `notes`/`chords` arrays. Pending messages from the old socket
    // can fire after the arrays are cleared, leaking the previous chart's data
    // into the new arrangement. Replacing the highway instance entirely orphans
    // the old closure so late messages can't pollute the new chart.
    function recreatePanelHighway(panel, opts) {
        const old = panel.hw;
        const inverted = old.getInverted();
        const lefty = old.getLefty();
        const lyricsVisible = typeof old.getLyricsVisible === 'function' ? old.getLyricsVisible() : true;
        const mastery = old.getMastery();
        old.stop();

        // Replace the canvas element so the new renderer can acquire its
        // context type on a FRESH canvas. Browsers permanently lock a canvas
        // to its first context type — a canvas that previously got
        // getContext('2d') silently returns null for getContext('webgl'),
        // and vice versa. Reusing the old canvas across renderer types
        // would break WebGL viz plugins on 2D↔viz and viz↔viz arrangement
        // switches; replacing the element sidesteps the lock entirely.
        const oldCanvas = panel.canvas;
        const newCanvas = document.createElement('canvas');
        newCanvas.style.cssText = oldCanvas.style.cssText || 'width:100%;height:100%;display:block;';
        oldCanvas.replaceWith(newCanvas);
        panel.canvas = newCanvas;

        const hw = createHighway();
        hw.resize = function () {
            const c = panel.canvas;
            if (!c) return;
            const rect = panel.panelDiv.getBoundingClientRect();
            const barH = panel.bar.style.display === 'none' ? 0 : (panel.bar.offsetHeight || 28);
            const w = rect.width;
            const h = Math.max(0, rect.height - barH);
            c.style.width = w + 'px';
            c.style.height = h + 'px';
            const scale = hw.getRenderScale();
            c.width = Math.round(w * scale);
            c.height = Math.round(h * scale);
        };
        // Pre-install the renderer BEFORE hw.init so the canvas locks to the
        // correct context type (e.g. WebGL for 3D Highway) on first init.
        // Same restore-on-load technique used by initPanel for saved viz prefs.
        if (opts?.preInstallRenderer) {
            hw.setRenderer(opts.preInstallRenderer);
        }
        hw.init(panel.canvas);
        hw.setInverted(inverted);
        hw.setLefty(lefty);
        if (typeof hw.setLyricsVisible === 'function') hw.setLyricsVisible(lyricsVisible);
        hw.setMastery(mastery);
        hw.resize();
        panel.hw = hw;
    }

    // ── Per-panel viz controls ("3D ⚙" popover) ──
    // Per-panel values live in the viz plugin's own per-panel localStorage keys
    // (highway_3d: h3d_bg_panel<N>_<key>, fallback global h3d_bg_<key>) — NOT in
    // splitscreenPanelPrefs. Writing the per-panel key is enough for the 3D
    // renderer (it re-reads all settings each frame); for instant-rebuild
    // settings (palette) we also re-fire the plugin's global setter with its
    // existing value so _bgEmitChange runs. No global state changes hands.
    function _vizPanelGet(pluginId, panelIdx, ctl) {
        let v = null;
        try {
            v = localStorage.getItem('h3d_bg_panel' + panelIdx + '_' + ctl.key);
            if (v == null) v = localStorage.getItem('h3d_bg_' + ctl.key);
        } catch (_) { /* storage blocked */ }
        if (v == null) return ctl.default;
        if (ctl.type === 'toggle') return v === 'true' || v === '1';
        if (ctl.type === 'range') {
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return ctl.default;
            const { lo, hi } = _ctlRange(ctl);
            return Math.max(lo, Math.min(hi, n));
        }
        return v;
    }
    function _vizPanelSet(pluginId, panelIdx, ctl, value) {
        try { localStorage.setItem('h3d_bg_panel' + panelIdx + '_' + ctl.key, String(value)); } catch (_) {}
        // Re-fire the plugin's global setter with the global's *current* value
        // (or the descriptor default if the global was never set) — the global
        // is unchanged, but this triggers the plugin's change event so each
        // renderer reloads and re-reads its per-panel key. Required for
        // rebuild-type settings (palette retints materials only on this event);
        // for the rest the 3D renderer's per-frame settings re-read would
        // suffice, but firing is harmless. Pass the value in the descriptor's
        // declared type — some 3D checkbox setters do `!!v`, so a non-empty
        // string like 'false' would wrongly coerce to true. Skip only if the
        // plugin isn't loaded / has no matching setter.
        const cap = ctl.key.charAt(0).toUpperCase() + ctl.key.slice(1);
        const setter = window['h3dBgSet' + cap];
        if (typeof setter !== 'function') return;
        let raw = null;
        try { raw = localStorage.getItem('h3d_bg_' + ctl.key); } catch (_) {}
        let v;
        if (ctl.type === 'toggle') {
            v = (raw == null) ? !!ctl.default : (raw === 'true' || raw === '1');
        } else if (ctl.type === 'range') {
            v = (raw == null) ? Number(ctl.default) : parseFloat(raw);
            if (!Number.isFinite(v)) v = Number(ctl.default);
        } else {
            v = (raw == null) ? String(ctl.default) : raw;
        }
        try { setter(v); } catch (_) {}
    }

    function buildVizPopover(panel, pluginId) {
        const pop = panel.vizPopover;
        if (!pop) return;
        pop.innerHTML = '';
        const controls = getPanelControlsFor(pluginId);
        const idx = panels.indexOf(panel);
        if (!controls || idx === -1) return;
        const title = document.createElement('div');
        title.textContent = (vizPlugins.find(p => p.id === pluginId)?.name || pluginId) + ' — this panel';
        title.style.cssText = 'font-size:10px;color:#6b7280;margin-bottom:6px;white-space:nowrap;';
        pop.appendChild(title);
        for (const ctl of controls) {
            const row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px;color:#cbd5e1;white-space:nowrap;cursor:pointer;';
            const name = document.createElement('span');
            name.textContent = ctl.label;
            name.style.cssText = 'flex:1;';
            const cur = _vizPanelGet(pluginId, idx, ctl);
            if (ctl.type === 'toggle') {
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!cur;
                cb.onchange = () => _vizPanelSet(pluginId, panels.indexOf(panel), ctl, cb.checked);
                row.appendChild(name);
                row.appendChild(cb);
            } else if (ctl.type === 'range') {
                const { lo, hi, st } = _ctlRange(ctl);
                const sl = document.createElement('input');
                sl.type = 'range';
                sl.min = String(lo); sl.max = String(hi); sl.step = String(st);
                sl.value = String(cur);
                sl.style.cssText = 'width:90px;accent-color:#4080e0;';
                const val = document.createElement('span');
                val.style.cssText = 'width:30px;text-align:right;color:#9ca3af;font-size:10px;';
                val.textContent = Number(cur).toFixed(2);
                sl.oninput = () => {
                    const v = parseFloat(sl.value);
                    val.textContent = (Number.isFinite(v) ? v : Number(ctl.default ?? 0)).toFixed(2);
                    _vizPanelSet(pluginId, panels.indexOf(panel), ctl, v);
                };
                row.appendChild(name);
                row.appendChild(sl);
                row.appendChild(val);
            } else if (ctl.type === 'select') {
                const sel = document.createElement('select');
                sel.style.cssText = 'background:#1a1a2e;border:1px solid #333;border-radius:4px;padding:2px 4px;font-size:10px;color:#ccc;outline:none;';
                for (const opt of (ctl.options || [])) {
                    const o = document.createElement('option');
                    o.value = opt.id; o.textContent = opt.label;
                    sel.appendChild(o);
                }
                sel.value = String(cur);
                sel.onchange = () => _vizPanelSet(pluginId, panels.indexOf(panel), ctl, sel.value);
                row.appendChild(name);
                row.appendChild(sel);
            } else {
                continue;
            }
            pop.appendChild(row);
        }
    }

    function _showVizControls(panel, pluginId) {
        if (!panel.vizSettingsBtn) return;
        const ctrls = getPanelControlsFor(pluginId);
        if (!ctrls || !ctrls.length) { _hideVizControls(panel); return; }
        buildVizPopover(panel, pluginId);
        panel.vizSettingsBtn.style.display = '';
    }
    function _hideVizControls(panel) {
        if (panel.vizSettingsBtn) panel.vizSettingsBtn.style.display = 'none';
        if (panel.vizPopover) { panel.vizPopover.style.display = 'none'; panel.vizPopover.innerHTML = ''; }
    }
    function _closeAllVizPopovers() {
        for (const p of panels) if (p.vizPopover) p.vizPopover.style.display = 'none';
    }
    // Close any open viz popover when clicking outside it / its trigger button.
    document.addEventListener('pointerdown', (e) => {
        const t = e.target;
        if (t && typeof t.closest === 'function' && (t.closest('.ss-viz-popover') || t.closest('[data-ss-viz-btn]'))) return;
        _closeAllVizPopovers();
    }, true);

    // ── Mastery slider helpers ──
    function hookPanelReady(panel) {
        panel.masterySlider.disabled = true;
        panel.masterySlider.style.opacity = '0.4';
        panel.masterySlider.style.cursor = 'not-allowed';
        panel.masteryLabel.textContent = '—';
        const prev = panel.hw._onReady;
        panel.hw._onReady = () => {
            if (prev) prev();
            const has = panel.hw.hasPhraseData();
            panel.masterySlider.disabled = !has;
            panel.masterySlider.style.opacity = has ? '1' : '0.4';
            panel.masterySlider.style.cursor = has ? 'pointer' : 'not-allowed';
            panel.masteryLabel.textContent = has ? panel.masterySlider.value + '%' : '—';
        };
    }

    // ── Panel lifecycle ──
    function populateSelect(panel, arrIndex) {
        // If /api/plugins fetch failed earlier, re-scan window for viz
        // factories every time the dropdown is built — covers viz plugin
        // scripts that load asynchronously after splitscreen first opened.
        // No-op when the registry fetch succeeded (vizPlugins is the
        // authoritative metadata list including names that aren't on window).
        if (_vizPluginsFetchFailed) _rescanVizPluginsFromWindow();
        panel.select.innerHTML = '';
        arrangements.forEach((a, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = a.name || `Arr ${i}`;
            if (i === arrIndex && !panel.lyricsMode) opt.selected = true;
            panel.select.appendChild(opt);
        });
        const lyricsOpt = document.createElement('option');
        lyricsOpt.value = LYRICS_VALUE;
        lyricsOpt.textContent = 'Lyrics';
        if (panel.lyricsMode) lyricsOpt.selected = true;
        panel.select.appendChild(lyricsOpt);

        if (typeof window.createJumpingTabPane === 'function') {
            arrangements.forEach((a, i) => {
                const jtOpt = document.createElement('option');
                jtOpt.value = JUMPING_TAB_VALUE + ':' + i;
                jtOpt.textContent = (a.name || `Arr ${i}`) + ' (JT)';
                if (panel.jumpingTabMode && panel.arrIndex === i) jtOpt.selected = true;
                panel.select.appendChild(jtOpt);
            });
        }

        vizPlugins.filter(vp => hasVizFactory(vp.id)).forEach(vp => {
            arrangements.forEach((a, i) => {
                const opt = document.createElement('option');
                opt.value = VIZ_PREFIX + ':' + vp.id + ':' + i;
                opt.textContent = (a.name || `Arr ${i}`) + ' (' + (vp.name || vp.id) + ')';
                if (panel.vizMode === vp.id && panel.arrIndex === i) opt.selected = true;
                panel.select.appendChild(opt);
            });
        });

        // Any registered viz plugin whose factory hasn't loaded yet? Kick
        // off the bounded poll so the picker auto-repopulates once their
        // script registers window.slopsmithViz_<id>. Single-flight — cheap
        // to call on every populateSelect.
        if (vizPlugins.some(vp => !hasVizFactory(vp.id))) {
            _startVizFactoryWatch();
        }
    }

    function enterLyricsMode(panel) {
        if (panel.lyricsMode) return;

        if (panel.vizMode) exitVizMode(panel, panel.arrIndex);
        if (panel.jumpingTabMode) exitJumpingTabMode(panel, panel.arrIndex);
        if (panel.tabActive) togglePanelTab(panel);
        panel.hw.stop();
        panel.canvas.style.display = 'none';

        // Hide highway-specific buttons and mastery slider
        panel.invertBtn.style.display = 'none';
        panel.leftyBtn.style.display = 'none';
        panel.tabBtn.style.display = 'none';
        panel.masteryHeading.style.display = 'none';
        panel.masterySlider.style.display = 'none';
        panel.masteryLabel.style.display = 'none';
        _hideVizControls(panel);

        panel.lyricsPane = createLyricsPane(panel.panelDiv);
        panel.lyricsPane.el.style.bottom = (panel.bar.offsetHeight || 28) + 'px';
        panel.lyricsPane.connect(currentFilename, 0);
        panel.lyricsMode = true;
        panel.select.value = LYRICS_VALUE;
        panel.arrName.textContent = 'Lyrics';
        savePanelPrefs();
    }

    function exitLyricsMode(panel, arrIndex) {
        if (!panel.lyricsMode) return;

        if (panel.lyricsPane) {
            panel.lyricsPane.destroy();
            panel.lyricsPane.el.remove();
            panel.lyricsPane = null;
        }

        panel.canvas.style.display = '';
        panel.invertBtn.style.display = '';
        panel.leftyBtn.style.display = '';
        panel.tabBtn.style.display = '';
        panel.masteryHeading.style.display = '';
        panel.masterySlider.style.display = '';
        panel.masteryLabel.style.display = '';
        panel.lyricsMode = false;

        panel.hw.init(panel.canvas);
        panel.hw.resize();
        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });
        savePanelPrefs();
    }

    function enterJumpingTabMode(panel) {
        if (panel.jumpingTabMode) return;

        if (panel.vizMode) exitVizMode(panel, panel.arrIndex);
        if (panel.lyricsMode) exitLyricsMode(panel, panel.arrIndex);
        if (panel.tabActive) togglePanelTab(panel);
        panel.hw.stop();
        panel.canvas.style.display = 'none';

        panel.invertBtn.style.display = 'none';
        panel.leftyBtn.style.display = 'none';
        panel.tabBtn.style.display = 'none';
        panel.masteryHeading.style.display = 'none';
        panel.masterySlider.style.display = 'none';
        panel.masteryLabel.style.display = 'none';
        _hideVizControls(panel);

        const jtContainer = document.createElement('div');
        jtContainer.style.cssText =
            'position:absolute;top:0;left:0;right:0;bottom:' +
            ((panel.bar.offsetHeight || 28) + 'px') +
            ';overflow:hidden;background:#0f1420;z-index:2;';
        panel.panelDiv.appendChild(jtContainer);

        const pane = window.createJumpingTabPane({ container: jtContainer });
        if (currentFilename) {
            pane.connect(currentFilename, panel.arrIndex).catch(e => {
                console.warn('[splitscreen] jumping tab connect failed:', e.message);
            });
        }
        panel.jumpingTabMode = true;
        panel.jumpingTabPane = pane;
        panel.jumpingTabContainer = jtContainer;
        panel.select.value = JUMPING_TAB_VALUE + ':' + panel.arrIndex;
        panel.arrName.textContent = (arrangements[panel.arrIndex]?.name || '') + ' (JT)';
        savePanelPrefs();
    }

    function exitJumpingTabMode(panel, arrIndex) {
        if (!panel.jumpingTabMode) return;

        if (panel.jumpingTabPane) {
            panel.jumpingTabPane.destroy();
            panel.jumpingTabPane = null;
        }
        if (panel.jumpingTabContainer) {
            panel.jumpingTabContainer.remove();
            panel.jumpingTabContainer = null;
        }

        panel.canvas.style.display = '';
        panel.invertBtn.style.display = '';
        panel.leftyBtn.style.display = '';
        panel.tabBtn.style.display = '';
        panel.masteryHeading.style.display = '';
        panel.masterySlider.style.display = '';
        panel.masteryLabel.style.display = '';
        panel.jumpingTabMode = false;

        panel.hw.init(panel.canvas);
        panel.hw.resize();
        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });
        savePanelPrefs();
    }

    function enterVizMode(panel, pluginId, rendererPreInstalled) {
        if (panel.vizMode) return;

        if (panel.lyricsMode) exitLyricsMode(panel, panel.arrIndex);
        if (panel.jumpingTabMode) exitJumpingTabMode(panel, panel.arrIndex);
        if (panel.tabActive) togglePanelTab(panel);

        panel.tabBtn.style.display = 'none';

        // Skip setRenderer when the caller already installed the renderer
        // before hw.init (restore-on-load path) to avoid creating a redundant
        // renderer instance and to respect the canvas context-type lock order.
        if (!rendererPreInstalled) {
            // Build the renderer instance FIRST so a throwing factory
            // doesn't tear down the highway / canvas before we know it
            // works. On throw, restore the buttons we just hid and bail
            // — panel keeps its previous (now-2D-after-exit*) highway.
            let newRenderer;
            try {
                newRenderer = vizFactory(pluginId)();
            } catch (e) {
                console.error('[splitscreen] viz factory threw for', pluginId, '— staying in 2D:', e);
                panel.tabBtn.style.display = '';
                return;
            }
            // Recreate the highway with a fresh canvas + the viz renderer
            // pre-installed so the canvas locks to the renderer's context
            // type (WebGL for 3D Highway, 2D for piano/drums) on first init.
            // Without the pre-install, recreatePanelHighway's hw.init would
            // try the default 2D context and silently break WebGL viz.
            recreatePanelHighway(panel, { preInstallRenderer: newRenderer });
        }
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, panel.arrIndex), { onSongInfo: () => {} });
        panel.vizMode = pluginId;

        panel.updateInvertStyle(panel.hw.getInverted());
        panel.invertBtn.onclick = () => {
            const on = !panel.hw.getInverted();
            panel.hw.setInverted(on);
            panel.updateInvertStyle(on);
            savePanelPrefs();
        };
        panel.updateLeftyStyle(panel.hw.getLefty());
        panel.leftyBtn.onclick = () => {
            const on = !panel.hw.getLefty();
            panel.hw.setLefty(on);
            panel.updateLeftyStyle(on);
            savePanelPrefs();
        };

        const vp = vizPlugins.find(p => p.id === pluginId);
        panel.select.value = VIZ_PREFIX + ':' + pluginId + ':' + panel.arrIndex;
        panel.arrName.textContent = (arrangements[panel.arrIndex]?.name || '') + ' (' + (vp?.name || pluginId) + ')';
        _showVizControls(panel, pluginId);
        savePanelPrefs();
    }

    function exitVizMode(panel, arrIndex) {
        if (!panel.vizMode) return;

        // Clear the renderer first so it can release its resources (WebGL
        // context, event listeners) via its own cleanup path, then recreate
        // the highway to give the fresh 2D renderer a clean canvas.
        panel.hw.setRenderer(null);
        recreatePanelHighway(panel);
        panel.vizMode = null;

        _hideVizControls(panel);
        panel.tabBtn.style.display = '';

        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });

        panel.updateInvertStyle(panel.hw.getInverted());
        panel.invertBtn.onclick = () => {
            const on = !panel.hw.getInverted();
            panel.hw.setInverted(on);
            panel.updateInvertStyle(on);
            savePanelPrefs();
        };
        panel.updateLeftyStyle(panel.hw.getLefty());
        panel.leftyBtn.onclick = () => {
            const on = !panel.hw.getLefty();
            panel.hw.setLefty(on);
            panel.updateLeftyStyle(on);
            savePanelPrefs();
        };

        savePanelPrefs();
    }

    function initPanel(panel, arrIndex, prefs) {
        const isLyricsMode = prefs?.arrName === LYRICS_VALUE;
        const isJumpingTabMode = prefs?.arrName?.startsWith(JUMPING_TAB_VALUE) || false;
        const isVizMode = prefs?.arrName?.startsWith(VIZ_PREFIX + ':') || false;
        let savedVizPluginId = null;
        if (isJumpingTabMode) {
            const jtArrName = prefs.arrName.slice(JUMPING_TAB_VALUE.length + 1);
            const jtIdx = resolveArrIndex(jtArrName);
            panel.arrIndex = jtIdx >= 0 ? jtIdx : arrIndex;
        } else if (isVizMode) {
            const parts = prefs.arrName.split(':');
            savedVizPluginId = parts[1];
            const vizArrName = parts.slice(2).join(':');
            const vizIdx = resolveArrIndex(vizArrName);
            panel.arrIndex = vizIdx >= 0 ? vizIdx : arrIndex;
        } else {
            panel.arrIndex = isLyricsMode ? 0 : arrIndex;
        }
        panel.lyricsMode = false;
        panel.lyricsPane = null;
        panel.lyricsOverlay = null;
        panel.lyricsOverlayOn = false;
        panel.jumpingTabMode = false;
        panel.jumpingTabPane = null;
        panel.jumpingTabContainer = null;
        panel.vizMode = null;

        // For viz restore: install the renderer BEFORE hw.init so the canvas
        // context is locked to the correct type (2D vs WebGL) on first init.
        // See CLAUDE.md "Canvas context-type lock" caveat.
        const vizFactoryFn = isVizMode && savedVizPluginId
            ? vizFactory(savedVizPluginId)
            : null;
        // Guard the factory call. A buggy viz plugin throwing here would
        // bubble out of initPanel and abort the entire splitscreen start
        // (caught only by startSplitScreen's catch — every panel torn down
        // because one viz factory threw). Fall back to default 2D for just
        // this panel instead.
        let vizInstalled = false;
        if (typeof vizFactoryFn === 'function') {
            try {
                panel.hw.setRenderer(vizFactoryFn());
                vizInstalled = true;
            } catch (e) {
                console.error('[splitscreen] viz factory threw for', savedVizPluginId, '— falling back to 2D for panel:', e);
            }
        }

        panel.hw.init(panel.canvas);

        // Apply saved preferences
        if (prefs && !isLyricsMode && !isJumpingTabMode) {
            if (prefs.inverted !== undefined) panel.hw.setInverted(prefs.inverted);
            if (prefs.lefty !== undefined) panel.hw.setLefty(prefs.lefty);
            if (prefs.lyrics !== undefined && typeof panel.hw.setLyricsVisible === 'function') {
                panel.hw.setLyricsVisible(prefs.lyrics);
            }
        }

        const savedMastery = (prefs?.mastery !== undefined) ? prefs.mastery : 1;
        panel.hw.setMastery(savedMastery);
        panel.masterySlider.value = Math.round(savedMastery * 100);
        panel.masterySlider.oninput = () => {
            const pct = parseInt(panel.masterySlider.value);
            panel.hw.setMastery(pct / 100);
            panel.masteryLabel.textContent = pct + '%';
            savePanelPrefs();
        };

        // Per-panel viz controls live in the "3D ⚙" popover, which owns its own
        // input handlers (built by buildVizPopover via _showVizControls when the
        // panel enters viz mode). Nothing to wire here.

        // Pop Out / Dock button handler. In the main window: pop out this panel
        // into a new browser window. In the popup (FOLLOWER): post a `docked`
        // message so the main reinstates the panel, then close the popup.
        panel.popOutBtn.onclick = () => {
            if (FOLLOWER) dockFollowerPanel(panel);
            else popOutPanel(panel);
        };

        // Populate arrangement dropdown (includes Lyrics, JT, and viz plugin options).
        // Use panel.arrIndex (already resolved from prefs above) so the dropdown
        // reflects the saved arrangement even when a special-mode restore is
        // about to fall back to plain 2D — e.g. saved viz pref but the renderer
        // factory isn't loaded, in which case enterVizMode never runs to correct
        // the selection.
        populateSelect(panel, panel.arrIndex);

        panel.arrName.textContent = isLyricsMode ? 'Lyrics'
            : isJumpingTabMode ? 'Jumping Tab'
            : (isVizMode && vizInstalled) ? (arrangements[panel.arrIndex]?.name || '') + ' (viz)'
            : (arrangements[panel.arrIndex]?.name || '');

        panel.select.onchange = () => {
            const val = panel.select.value;
            if (val.startsWith(JUMPING_TAB_VALUE + ':')) {
                const jtIdx = parseInt(val.split(':')[1]);
                panel.arrIndex = jtIdx;
                if (panel.jumpingTabMode) {
                    panel.jumpingTabPane.destroy();
                    panel.jumpingTabPane = null;
                    panel.jumpingTabContainer.remove();
                    panel.jumpingTabContainer = null;
                    panel.jumpingTabMode = false;
                }
                enterJumpingTabMode(panel);
            } else if (val.startsWith(VIZ_PREFIX + ':')) {
                const parts    = val.split(':');
                const pluginId = parts[1];
                const vizIdx   = parseInt(parts[2]);
                panel.arrIndex = vizIdx;
                if (panel.vizMode) {
                    // Build the new renderer first so a throwing factory
                    // doesn't leave the panel half-torn-down. On throw,
                    // fall through to a default 2D highway for vizIdx so
                    // the panel still has a working chart.
                    let newRenderer;
                    try {
                        newRenderer = vizFactory(pluginId)();
                    } catch (e) {
                        console.error('[splitscreen] viz factory threw for', pluginId, '— falling back to 2D:', e);
                        exitVizMode(panel, vizIdx);
                        return;
                    }
                    // Clear the current renderer so it can release its
                    // resources (WebGL context, event listeners), then
                    // recreate the highway with the new renderer pre-installed
                    // — the fresh canvas locks to the new context type, and
                    // the orphaned old WS can't leak notes into the new chart.
                    panel.hw.setRenderer(null);
                    recreatePanelHighway(panel, { preInstallRenderer: newRenderer });
                    hookPanelReady(panel);
                    panel.hw.connect(getWsUrl(currentFilename, vizIdx), { onSongInfo: () => {} });
                    panel.vizMode = pluginId;
                    const vp = vizPlugins.find(p => p.id === pluginId);
                    panel.arrName.textContent = (arrangements[vizIdx]?.name || '') + ' (' + (vp?.name || pluginId) + ')';
                    // Re-bind invert handler on the fresh hw
                    panel.updateInvertStyle(panel.hw.getInverted());
                    panel.invertBtn.onclick = () => {
                        const on = !panel.hw.getInverted();
                        panel.hw.setInverted(on);
                        panel.updateInvertStyle(on);
                        savePanelPrefs();
                    };
                    panel.updateLeftyStyle(panel.hw.getLefty());
                    panel.leftyBtn.onclick = () => {
                        const on = !panel.hw.getLefty();
                        panel.hw.setLefty(on);
                        panel.updateLeftyStyle(on);
                        savePanelPrefs();
                    };
                    _showVizControls(panel, pluginId);
                    savePanelPrefs();
                } else {
                    enterVizMode(panel, pluginId);
                }
            } else if (val === LYRICS_VALUE) {
                enterLyricsMode(panel);
            } else {
                const newIdx = parseInt(val);
                if (panel.jumpingTabMode) {
                    exitJumpingTabMode(panel, newIdx);
                } else if (panel.vizMode) {
                    exitVizMode(panel, newIdx);
                } else if (panel.lyricsMode) {
                    exitLyricsMode(panel, newIdx);
                } else {
                    switchPanelArrangement(panel, newIdx);
                }
            }
            savePanelPrefs();
        };

        // Per-panel invert toggle
        panel.updateInvertStyle(panel.hw.getInverted());
        panel.invertBtn.onclick = () => {
            const on = !panel.hw.getInverted();
            panel.hw.setInverted(on);
            panel.updateInvertStyle(on);
            savePanelPrefs();
        };
        panel.updateLeftyStyle(panel.hw.getLefty());
        panel.leftyBtn.onclick = () => {
            const on = !panel.hw.getLefty();
            panel.hw.setLefty(on);
            panel.updateLeftyStyle(on);
            savePanelPrefs();
        };

        // Per-panel lyrics toggle. Always renders a transparent overlay band
        // anchored to top of the panel (z-index above bar + viz renderers),
        // so it works regardless of which renderer (2D, piano, drums, 3D
        // Highway, future viz) owns the canvas. Future-proof: any new viz
        // plugin gets lyric support for free without modification.
        // Also keeps the highway's built-in setLyricsVisible (in-canvas
        // underline cue) in sync — complementary to the overlay text.
        panel.lyricsOverlayOn = prefs?.lyrics === true;
        const _toggleLyricsOverlay = (on) => {
            if (on) {
                if (panel.lyricsOverlay) panel.lyricsOverlay.destroy();
                panel.lyricsOverlay = createLyricsPane(panel.panelDiv, { overlay: true });
                // Connect with arrangement 0 — lyrics are song-level (same
                // across arrangements) and this matches enterLyricsMode's
                // full-pane connect, so the overlay doesn't need to
                // reconnect when the user switches arrangement on the panel.
                panel.lyricsOverlay.connect(currentFilename, 0);
            } else if (panel.lyricsOverlay) {
                panel.lyricsOverlay.destroy();
                panel.lyricsOverlay.el.remove();
                panel.lyricsOverlay = null;
            }
            if (typeof panel.hw.setLyricsVisible === 'function') {
                panel.hw.setLyricsVisible(on);
            }
            panel.updateLyricsStyle(on);
        };
        // Always invoke _toggleLyricsOverlay so the highway's built-in
        // lyricsVisible flag (which feeds bundle.lyricsVisible consumed by
        // viz renderers like 3D highway) is synced to the saved toggle
        // state. Without this, viz panels with overlay off would still
        // render lyrics because the built-in flag defaults to true.
        _toggleLyricsOverlay(panel.lyricsOverlayOn);
        panel.lyricsBtn.onclick = () => {
            panel.lyricsOverlayOn = !panel.lyricsOverlayOn;
            _toggleLyricsOverlay(panel.lyricsOverlayOn);
            savePanelPrefs();
        };

        // Per-panel Highway/Tab mode toggle (uses tabview factory)
        const hasTabFactory = typeof window.createTabView === 'function';
        if (hasTabFactory) {
            panel.tabBtn.onclick = () => togglePanelTab(panel);
        } else {
            panel.tabBtn.disabled = true;
            panel.tabBtn.title = 'Tab View plugin not loaded';
            panel.tabBtn.style.opacity = '0.4';
        }

        // Per-panel note detection (uses note_detect factory)
        panel.detectChannel = prefs?.detectChannel || 'mono';
        // Clamp a saved channel that's no longer offered (e.g. a deferred-multichannel
        // 'ch3'+ from an earlier build) back to mono so the button label + value resolve.
        if (!(panel.detectChannel in DETECT_CHANNEL_VALUE)) panel.detectChannel = 'mono';
        panel.detector = null;
        // Phase 2: which input DEVICE this panel detects from. 0 = the engine's
        // primary input; >0 = an additional interface bound via the device picker.
        panel.detectDeviceKey = 0;
        // detectDeviceName tracks the device a bind actually SUCCEEDED on — start empty
        // (Main). Do NOT preload it from prefs: that would make the panel claim the
        // device before its restore-bind ran, so the in-use / duplicate / failure-rollback
        // checks treat it as bound and could leak its reserved key. The saved name is the
        // restore TARGET only (setupDevicePicker binds it, which sets detectDeviceName).
        panel.detectDeviceName = '';
        panel._ssSavedDeviceName = prefs?.detectDeviceName || '';
        // Per-panel detection-timing offset (ms) for an extra input device.
        panel.detectVerifierOffsetMs = Number.isFinite(prefs?.detectVerifierOffsetMs) ? prefs.detectVerifierOffsetMs : 0;
        panel.channelBtn.textContent = DETECT_CHANNEL_LABELS[panel.detectChannel];
        if (panel.latVal) panel.latVal.textContent = (panel.detectVerifierOffsetMs > 0 ? '+' : '') + panel.detectVerifierOffsetMs + 'ms';
        const hasNoteDetect = typeof window.createNoteDetector === 'function';
        if (hasNoteDetect) {
            panel.detectBtn.onclick = () => toggleDetect(panel);
            panel.channelBtn.onclick = () => cycleDetectChannel(panel);
            if (panel.latDown) panel.latDown.onclick = () => _ssNudgeOffset(panel, -5);
            if (panel.latUp) panel.latUp.onclick = () => _ssNudgeOffset(panel, +5);
            setupDevicePicker(panel);
        } else {
            panel.detectBtn.disabled = true;
            panel.detectBtn.title = 'Note Detect plugin not loaded';
            panel.detectBtn.style.opacity = '0.4';
            panel.channelBtn.disabled = true;
            panel.channelBtn.style.opacity = '0.4';
        }

        if (isLyricsMode) {
            enterLyricsMode(panel);
        } else if (isJumpingTabMode) {
            enterJumpingTabMode(panel);
        } else if (isVizMode && vizInstalled) {
            // Renderer was already installed before hw.init above; pass true to
            // skip the redundant setRenderer call inside enterVizMode. If the
            // factory threw earlier (vizInstalled=false), fall through to the
            // plain-2D else-branch so the panel still gets a working highway.
            enterVizMode(panel, savedVizPluginId, /* rendererPreInstalled */ true);
        } else {
            // Connect WebSocket. Pass an empty onSongInfo so core skips its
            // default writes to shared HUD / audio / arrangement dropdown
            // — otherwise every panel's song_info clobbers the main view.
            // See got-feedback/feedBack#27.
            hookPanelReady(panel);
            panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });
        }
    }

    async function togglePanelTab(panel) {
        if (panel.tabActive) {
            // Back to highway
            if (panel.tabInstance) {
                try { panel.tabInstance.destroy(); } catch (_) {}
                panel.tabInstance = null;
            }
            if (panel.tabContainer) {
                panel.tabContainer.remove();
                panel.tabContainer = null;
            }
            panel.canvas.style.display = '';
            panel.tabActive = false;
            panel.updateTabStyle(false);
            return;
        }

        const prevLabel = panel.tabBtn.textContent;
        panel.tabBtn.textContent = '…';
        panel.tabBtn.disabled = true;
        try {
            const decoded = decodeURIComponent(currentFilename);
            const url = '/api/plugins/tabview/gp5/' +
                encodeURIComponent(decoded) +
                '?arrangement=' + panel.arrIndex;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.arrayBuffer();

            const tabContainer = document.createElement('div');
            tabContainer.style.cssText =
                'position:absolute;top:0;left:0;right:0;bottom:' +
                ((panel.bar.offsetHeight || 28) + 'px') +
                ';overflow:auto;background:#fff;z-index:2;';
            panel.panelDiv.appendChild(tabContainer);

            const tv = window.createTabView({
                container: tabContainer,
                getBeats: () => panel.hw.getBeats(),
                getCurrentTime: () => document.getElementById('audio').currentTime,
            });
            await tv.load(data);
            tv.startSync();

            panel.canvas.style.display = 'none';
            panel.tabContainer = tabContainer;
            panel.tabInstance = tv;
            panel.tabActive = true;
            panel.updateTabStyle(true);
        } catch (e) {
            console.error('[splitscreen] tab view error:', e);
            alert('Tab View error: ' + (e.message || e));
        } finally {
            panel.tabBtn.textContent = prevLabel;
            panel.tabBtn.disabled = false;
        }
    }

    function toggleDetect(panel) {
        if (panel.detector) {
            panel.detector.destroy();
            panel.detector = null;
            panel.updateDetectStyle(false);
            return;
        }
        if (typeof window.createNoteDetector !== 'function') return;
        panel.detector = window.createNoteDetector({
            highway: panel.hw,
            container: panel.panelDiv,
            channel: DETECT_CHANNEL_VALUE[panel.detectChannel] ?? -1,
            // Phase 2: bind this panel's source to its chosen input DEVICE (0 =
            // primary; >0 = an additional interface the device picker bound). Two
            // panels on two separate cables thus score fully independently.
            deviceKey: panel.detectDeviceKey || 0,
            verifierOffsetMs: panel.detectVerifierOffsetMs || 0,
            // Each panel scores its OWN engine input source so several panels run
            // independently (e.g. two guitars on two interfaces, or the L/R channels
            // of one). On the desktop bridge the detector allocates a dedicated
            // source bound to this device+channel; on the web path ownSource is a
            // no-op (each instance already opens its own getUserMedia + splitter).
            ownSource: true,
        });
        panel.detector.enable();
        panel.updateDetectStyle(true);
    }

    function cycleDetectChannel(panel) {
        // mono / left / right only — multi-channel selection (ch3+) is deferred (see
        // DETECT_CHANNEL_CYCLE). Each panel binds its OWN device via the picker, so a
        // panel scores channel 0/1 (or the mono mix) of that device.
        const idx = DETECT_CHANNEL_CYCLE.indexOf(panel.detectChannel);
        panel.detectChannel = DETECT_CHANNEL_CYCLE[(idx + 1) % DETECT_CHANNEL_CYCLE.length];
        panel.channelBtn.textContent = DETECT_CHANNEL_LABELS[panel.detectChannel];
        if (panel.detector) {
            panel.detector.setChannel(DETECT_CHANNEL_VALUE[panel.detectChannel]);
        }
        savePanelPrefs();
    }

    // Nudge a panel's detection-timing offset (ms) and apply it live to its bound
    // source. Lets the user dial in an extra device's capture latency by watching
    // the score peak. Clamped to ±250 ms.
    function _ssNudgeOffset(panel, delta) {
        const next = Math.max(-250, Math.min(250, (panel.detectVerifierOffsetMs || 0) + delta));
        panel.detectVerifierOffsetMs = next;
        if (panel.latVal) panel.latVal.textContent = (next > 0 ? '+' : '') + next + 'ms';
        if (panel.detector && typeof panel.detector.setVerifierOffset === 'function')
            panel.detector.setVerifierOffset(next);
        // Reset this panel's cumulative score so the NEW offset is measured cleanly
        // from scratch — otherwise the hit rate is dragged down by every worse value
        // tried earlier in the same session, making calibration impossible.
        if (panel.detector && typeof panel.detector._resetScoring === 'function')
            panel.detector._resetScoring();
        savePanelPrefs();
    }

    // Populate + wire the per-panel input DEVICE picker. No-op (and the dropdown
    // stays hidden) unless the desktop bridge exposes the Phase 2 multi-device API.
    async function setupDevicePicker(panel) {
        const sel = panel.deviceSelect;
        if (!sel) return;
        // NEVER bind extra devices from a pop-out/follower window. The deviceKey map is
        // module-local, so a popup independently allocating keys would trample the main
        // window's engine slots (both grabbing deviceKey 1 for different hardware). The
        // follower mirrors the main window's audio anyway — it leaves panels on Main
        // (deviceKey 0) and shows no picker. Extra-device binding stays single-window.
        if (FOLLOWER) { sel.style.display = 'none'; return; }
        const audio = _ssAudio();
        if (!audio || typeof audio.listInputDevices !== 'function'
            || typeof audio.bindInputDevice !== 'function') {
            sel.style.display = 'none';
            return;
        }
        let devices = null;
        try { devices = await audio.listInputDevices(); } catch (_) { devices = null; }
        // Bail if the split view was torn down / rebuilt while we awaited — this panel
        // is detached (its <select> left the DOM), so binding a device for it below
        // would orphan an extra-device slot no live panel owns (and pollute the
        // keymap for the next session). Happens on slow startup + a quick stop/layout
        // change before the picker finishes loading.
        if (!active || !sel.isConnected) return;
        if (!Array.isArray(devices) || devices.length === 0) {
            sel.style.display = 'none';
            return;
        }
        sel.innerHTML = '<option value="">Main</option>';
        // Show every device the host enumerates — do NOT collapse same-named entries
        // here. The engine's getBindableInputDevices() already returns a curated list
        // (and is the single place that handles JUCE's name-based device identity); a
        // second de-dup in the UI would only hide distinct interfaces it does expose.
        // `seen` just records the offered names for the restore check below.
        const seen = new Set();
        for (const d of devices) {
            const name = d && d.name;
            if (!name) continue;
            seen.add(name);
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name.length > 22 ? name.slice(0, 21) + '…' : name;
            opt.title = name;
            sel.appendChild(opt);
        }
        sel.style.display = '';
        // Reveal the per-panel timing-offset nudge alongside the device picker.
        if (panel.latWrap && typeof panel.latWrap.style !== 'undefined') panel.latWrap.style.display = 'inline-flex';
        // Restore a persisted device selection (binds it — _ssApplyDevice sets
        // detectDeviceName on success). Restore from the SAVED target, not the live
        // detectDeviceName (which is empty until a bind confirms).
        if (panel._ssSavedDeviceName && seen.has(panel._ssSavedDeviceName)) {
            sel.value = panel._ssSavedDeviceName;
            await _ssApplyDevice(panel, panel._ssSavedDeviceName);
        }
        sel.onchange = () => { _ssApplyDevice(panel, sel.value); };
    }

    // Resolve + bind the chosen device, set the panel's deviceKey, and rebind a live
    // detector. SERIALIZED per panel: each device change runs after the previous one
    // fully completes (bind + old-device unbind), so overlapping picks (A then B
    // before A's bind resolves) can't apply out of order and leave the panel on the
    // wrong device. Returns the chain tail so callers can await the actual apply.
    function _ssApplyDevice(panel, name) {
        panel._ssDeviceChain = (panel._ssDeviceChain || Promise.resolve())
            .catch(() => {})
            .then(() => _ssApplyDeviceImpl(panel, name));
        return panel._ssDeviceChain;
    }

    // "" = primary input. (A source's device is fixed at allocation, so a live
    // detector is torn down + rebuilt to move it.)
    async function _ssApplyDeviceImpl(panel, name) {
        // Record the device THIS panel is (about to be) bound to for the whole async
        // operation, BEFORE detectDeviceName is updated — so a concurrent
        // _ssMaybeUnbindDevice() from another panel's switch sees the in-flight handoff
        // and doesn't release the device out from under us. Cleared in finally.
        panel._ssPendingDeviceName = name || '';
        try {
            return await _ssApplyDeviceBody(panel, name);
        } finally {
            if (panel._ssPendingDeviceName === (name || '')) panel._ssPendingDeviceName = null;
        }
    }

    async function _ssApplyDeviceBody(panel, name) {
        const audio = _ssAudio();
        const startStopGen = _ssRealStopGen;  // detect a REAL stop racing this bind
        // Wait for any prior session's extra-device unbinds to finish before we bind —
        // otherwise binding a just-freed deviceKey can race a late-completing unbind
        // that would then tear down this fresh binding. No-op when nothing is pending.
        try { await _ssDeviceReleaseBarrier; } catch (_) { /* best-effort */ }
        const prevName = panel.detectDeviceName || '';
        if (!name) {
            panel.detectDeviceKey = 0;
            panel.detectDeviceName = '';
        } else {
            const key = _ssResolveDeviceKey(name);
            if (key < 0) {
                alert(`Multi-input supports up to ${SS_MAX_EXTRA_DEVICES} extra devices.`);
                panel.deviceSelect.value = panel.detectDeviceName || '';
                return;
            }
            if (audio && typeof audio.bindInputDevice === 'function') {
                let bindErr = null;
                try {
                    bindErr = await audio.bindInputDevice(key, name);
                } catch (e) {
                    // A THROW is a failure too — don't fall through and adopt a device
                    // whose engine slot never opened (the detector would bind a dead
                    // deviceKey and silently score nothing).
                    console.warn('[splitscreen] bindInputDevice failed:', e);
                    bindErr = (e && e.message) ? e.message : 'bind failed';
                }
                // "" = opened; "already bound" = another panel opened it (fine).
                if (bindErr && !/already bound/i.test(String(bindErr))) {
                    console.warn('[splitscreen] bindInputDevice:', bindErr);
                    alert('Could not open input device: ' + bindErr);
                    panel.deviceSelect.value = panel.detectDeviceName || '';
                    // Release the deviceKey _ssResolveDeviceKey just reserved for this
                    // name — otherwise a failed pick permanently consumes one of the
                    // limited extra-device slots. Clear our OWN in-flight marker first:
                    // _ssMaybeUnbindDevice's "still in use" guard checks _ssPendingDeviceName,
                    // which is still `name` here, so it would match this very panel and
                    // skip the unbind, leaking the key.
                    panel._ssPendingDeviceName = null;
                    await _ssMaybeUnbindDevice(name);
                    return;
                }
            }
            // The bind may have taken a while; if the split view was torn down /
            // rebuilt meanwhile, this panel is detached. Don't write its state or
            // re-toggle a dead detector. Whether to RELEASE the device we just bound
            // depends on WHY we're detached: a REAL stop (gen bumped) ran its unbind-all
            // BEFORE this late bind, so release the orphaned device by key (the keymap
            // may already be cleared). A REBUILD (gen unchanged) intentionally keeps the
            // bindings for the next session — likely already reused by the rebuilt
            // panel — so leave it bound, or we'd kill the new panel's source.
            if (!active || !panel.deviceSelect || !panel.deviceSelect.isConnected) {
                if (_ssRealStopGen !== startStopGen) {
                    const a2 = _ssAudio();
                    if (a2 && typeof a2.unbindInputDevice === 'function') {
                        const p = Promise.resolve(a2.unbindInputDevice(key)).catch(() => {});
                        _ssDeviceReleaseBarrier = Promise.allSettled([_ssDeviceReleaseBarrier, p]);
                        await p;
                    }
                    if (_ssDeviceKeyByName.get(name) === key) _ssDeviceKeyByName.delete(name);
                }
                return;
            }
            panel.detectDeviceKey = key;
            panel.detectDeviceName = name;
        }
        // Re-toggle to rebind the source to the new device if detect is live.
        if (panel.detector) { toggleDetect(panel); toggleDetect(panel); }
        // Release the device this panel just left if no other panel still uses it
        // (frees the engine slot + deviceKey; stops stale binds accumulating). AWAIT
        // it so this chained apply doesn't complete — letting the next queued change
        // start — until the old device is actually released (its key safely freed).
        if (prevName && prevName !== name) await _ssMaybeUnbindDevice(prevName);
        savePanelPrefs();
    }

    function switchPanelArrangement(panel, arrIndex) {
        panel.arrIndex = arrIndex;
        panel.arrName.textContent = arrangements[arrIndex]?.name || '';
        if (panel.tabActive) togglePanelTab(panel);
        recreatePanelHighway(panel);
        hookPanelReady(panel);
        panel.hw.connect(getWsUrl(currentFilename, arrIndex), { onSongInfo: () => {} });
    }

    function teardownPanels() {
        // Flip active + notify focus listeners up-front. All callers
        // (stopSplitScreen, rebuildLayout, popOutPanel, _redockPanel) need
        // active=false so a follow-up startSplitScreen() passes its
        // `_starting || active` re-entrancy guard. Centralising the flip
        // here removes the foot-gun of every restart path remembering to
        // clear it manually. Plugin destroy() handlers below run against
        // the inactive world view, which is what they expect when they
        // read isActive() during cleanup.
        active = false;
        _emitFocusChange();
        // A REBUILD (resize / arrangement switch) tears down then immediately
        // restarts, so it must KEEP the extra-device bindings + the main-detector
        // suppression — releasing + rebinding a tick later races the async unbind
        // (stale-device hand-off) and blips the main HUD. Only a REAL stop does the
        // full cleanup below. (startSplitScreen skips its capture/suppress when
        // _ssDetectSuppressed is still set, so the kept state isn't clobbered.)
        if (!_ssTransientTeardown) {
            _ssRealStopGen++;  // a real stop — in-flight binds use this to self-release
            // Split mode ending — release every extra input device the panels bound,
            // freeing the engine slots + deviceKeys so a later session starts clean.
            // Track the (async) unbinds in the release barrier so the NEXT session's
            // _ssApplyDevice waits for them to finish before rebinding a freed key —
            // otherwise a late unbind tears down the freshly-rebound device.
            {
                const audio = _ssAudio();
                // Chain ONTO the existing barrier — never replace it — so an unbind a
                // recent panel-switch already queued isn't dropped (its key could be
                // rebound by the next session before that older unbind completes).
                const pending = [_ssDeviceReleaseBarrier];
                if (audio && typeof audio.unbindInputDevice === 'function')
                    for (const key of _ssDeviceKeyByName.values())
                        try { pending.push(Promise.resolve(audio.unbindInputDevice(key)).catch(() => {})); } catch (_) { /* best-effort */ }
                _ssDeviceReleaseBarrier = Promise.allSettled(pending);
                _ssDeviceKeyByName.clear();
            }
            // Stop suppressing the singleton + restore it if split had silenced it.
            _ssSetDefaultSuppressed(false);
            _ssDetectSuppressed = false;
            if (_ssMainDetectWasOn) {
                try {
                    const nd = (typeof window !== 'undefined') ? window.noteDetect : null;
                    if (nd && typeof nd.enable === 'function') nd.enable();
                } catch (_) { /* best-effort */ }
                _ssMainDetectWasOn = false;
            }
        }
        for (const p of panels) {
            if (p.detector) {
                p.detector.destroy();
                p.detector = null;
            }
            if (p.lyricsPane) {
                p.lyricsPane.destroy();
                p.lyricsPane = null;
            }
            if (p.lyricsOverlay) {
                p.lyricsOverlay.destroy();
                p.lyricsOverlay.el.remove();
                p.lyricsOverlay = null;
            }
            if (p.jumpingTabPane) {
                p.jumpingTabPane.destroy();
                p.jumpingTabPane = null;
            }
            if (p.vizMode) {
                p.hw.setRenderer(null);
                p.vizMode = null;
            }
            if (p.tabInstance) {
                try { p.tabInstance.destroy(); } catch (_) {}
                p.tabInstance = null;
            }
            p.hw.stop();
        }
        panels = [];
        if (wrap) {
            wrap.remove();
            wrap = null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Pop-out / dock helpers
    // ══════════════════════════════════════════════════════════════════════

    function _captureMode(panel) {
        if (panel.lyricsMode) return 'lyrics';
        if (panel.jumpingTabMode) return 'jt';
        if (panel.vizMode) return 'viz:' + panel.vizMode;
        return '2d';
    }

    // Decode a captured panel mode into the saved-prefs `arrName` form.
    // Shared by _redockPanel and _followerCfgToPrefs so the popup-and-back
    // round-trip produces the same prefs the main-window flow would.
    //
    // Legacy: pre-PR-36 popups encoded 3D Highway as cfg.mode === '3d'
    // rather than 'viz:highway_3d'. Map it explicitly so a popup that was
    // opened on an older build and is now docking back lands on the
    // correct renderer instead of silently falling back to 2D.
    function _modeToArrName(mode, arrNameStr) {
        if (mode === 'lyrics') return LYRICS_VALUE;
        if (mode === 'jt') return JUMPING_TAB_VALUE + ':' + arrNameStr;
        if (mode === '3d') return VIZ_PREFIX + ':highway_3d:' + arrNameStr;
        if (mode?.startsWith('viz:')) return VIZ_PREFIX + ':' + mode.slice(4) + ':' + arrNameStr;
        return arrNameStr;
    }

    function _captureFollowerConfig(panel) {
        return {
            arrangement: panel.arrIndex || 0,
            mode:        _captureMode(panel),
            inverted:    panel.hw.getInverted() ? 1 : 0,
            lefty:       panel.hw.getLefty() ? 1 : 0,
            mastery:     panel.hw.getMastery(),
            // User-driven per-panel toggles that should survive a pop-out /
            // dock round-trip. Without these, docking always forces lyrics on
            // and bar visible regardless of pre-popout state.
            lyrics:        !!panel.lyricsOverlayOn,
            barHidden:     panel.bar?.style.display === 'none',
            detectChannel: panel.detectChannel || 'mono',
            // Carry the per-panel input DEVICE + timing calibration across a
            // pop-out/dock round-trip too — otherwise a panel bound to a secondary
            // interface (or with a dialed offset) silently reverts to Main/0ms on
            // redock. deviceKey is re-resolved on rebind, so name + offset suffice.
            detectDeviceName:       panel.detectDeviceName || '',
            detectVerifierOffsetMs: panel.detectVerifierOffsetMs || 0,
        };
    }

    function _newPopupId() {
        try {
            return crypto.randomUUID();
        } catch (_) {
            return 'p-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
        }
    }

    // Small non-blocking notice in the main window (replaces blocking alert()
    // for pop-out failures). Top-centre pill, fades in next frame, auto-removes
    // after ~3.5 s; a new call replaces any in-flight one.
    let _mainToastEl = null;
    function _showMainToast(msg) {
        try {
            if (_mainToastEl) { _mainToastEl.remove(); _mainToastEl = null; }
            const el = document.createElement('div');
            el.id = 'splitscreen-toast';
            el.textContent = msg;
            el.style.cssText =
                'position:fixed;top:24px;left:50%;transform:translateX(-50%) translateY(-12px);' +
                'max-width:80vw;padding:10px 18px;background:rgba(8,8,16,0.95);' +
                'border:1px solid #4080e0;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,0.55);' +
                'z-index:10002;font-family:sans-serif;font-size:13px;color:#e5e7eb;text-align:center;' +
                'opacity:0;transition:opacity 250ms ease,transform 250ms ease;pointer-events:none;';
            document.body.appendChild(el);
            _mainToastEl = el;
            requestAnimationFrame(() => {
                el.style.opacity = '1';
                el.style.transform = 'translateX(-50%) translateY(0)';
            });
            setTimeout(() => {
                if (_mainToastEl !== el) return;
                el.style.opacity = '0';
                el.style.transform = 'translateX(-50%) translateY(-12px)';
                setTimeout(() => { if (_mainToastEl === el) _mainToastEl = null; el.remove(); }, 300);
            }, 3500);
        } catch (_) { /* DOM not ready / detached — silently drop */ }
    }

    // Open a popup window pre-configured to show this panel as a follower.
    // The panel is removed from the main layout once the popup is opened
    // (slot collapses; rebuildLayout reflows remaining panels).
    function popOutPanel(panel) {
        if (!currentFilename) return;
        const idx = panels.indexOf(panel);
        if (idx === -1) return;
        if (typeof BroadcastChannel !== 'function') {
            _showMainToast('Pop-out requires a browser that supports BroadcastChannel.');
            return;
        }
        const cfg = _captureFollowerConfig(panel);
        const popupId = _newPopupId();

        const url = new URL(window.location.origin + '/');
        const sp = url.searchParams;
        sp.set('ssFollower', '1');
        sp.set('popupId', popupId);
        sp.set('filename', currentFilename);
        sp.set('arrangement', String(cfg.arrangement));
        sp.set('mode', cfg.mode);
        sp.set('inverted', String(cfg.inverted));
        sp.set('lefty', String(cfg.lefty || 0));
        sp.set('lyrics', cfg.lyrics ? '1' : '0');
        sp.set('barHidden', cfg.barHidden ? '1' : '0');
        sp.set('detectChannel', cfg.detectChannel || 'mono');
        sp.set('detectDeviceName', cfg.detectDeviceName || '');
        sp.set('detectVerifierOffsetMs', String(cfg.detectVerifierOffsetMs || 0));
        if (Number.isFinite(cfg.mastery)) sp.set('mastery', String(cfg.mastery));

        const popup = window.open(url.toString(), popupId, 'popup,width=1280,height=420');
        if (!popup) {
            _showMainToast('Pop-out blocked by the browser. Allow popups for this site and try again.');
            return;
        }
        // Track the popup (incl. its window handle so the broadcaster can reap
        // it if it dies without firing beforeunload).
        popups.set(popupId, { popup, originalConfig: cfg });
        // Force the next broadcaster tick to re-send the current time even if
        // the main audio is paused (== unchanged), so this freshly-opened
        // popup gets a playhead value instead of sitting at 0.
        _lastBroadcastTime = null;

        // Open the channel in the main window so we can broadcast time and
        // listen for the popup's docked / closed messages. Every `time`
        // message carries the current `playing` flag, so the fresh popup
        // learns the play/pause state from the first one it receives (the
        // _lastBroadcastTime reset above forces that to be sent promptly).
        _ensureMainBroadcasterAndListener();
        _startPopupBroadcaster();

        // Remove this panel from the live layout. The remaining panels are
        // rebuilt; if popping leaves only 1 panel we stop split entirely and
        // the main view goes back to its default highway. If 2 remain in a
        // quad layout we downgrade to top-bottom so we don't leave an empty
        // default slot in the grid.
        const wasActive = active;
        const remaining = panels.filter(p => p !== panel);
        const savedPrefs = remaining.map(panelToPrefs);

        if (wasActive && savedPrefs.length === 0) {
            // Single-panel split (rare) — pop out leaves nothing.
            stopSplitScreen();
            return;
        }
        if (wasActive && savedPrefs.length === 1) {
            // Last panel popped — go back to the default highway view.
            teardownPanels();
            stopSplitScreen();
            return;
        }
        // 2+ remaining. Downgrade quad → top-bottom if we'd otherwise leave
        // an empty default slot. Keep top-bottom / left-right as-is.
        if (wasActive && LAYOUTS[layout] && savedPrefs.length < LAYOUTS[layout].panels) {
            layout = 'top-bottom';
            try { localStorage.setItem('splitscreenLayout', layout); } catch (_) {}
        }
        if (wasActive) {
            // The popped-out panel leaves the main window (it becomes a follower that
            // binds nothing). The transient teardown below KEEPS remaining bindings, so
            // it won't free this panel's device — release it explicitly if no REMAINING
            // panel shares it, or its deviceKey leaks (and after a few pop-outs new binds
            // hit the max-device alert). It re-binds from saved prefs on dock-back.
            const poppedDev = panel.detectDeviceName;
            if (poppedDev && !remaining.some(p => p && p.detectDeviceName === poppedDev)) {
                const key = _ssDeviceKeyByName.get(poppedDev);
                if (key != null) {
                    _ssDeviceKeyByName.delete(poppedDev);
                    const audio = _ssAudio();
                    if (audio && typeof audio.unbindInputDevice === 'function') {
                        const p = Promise.resolve(audio.unbindInputDevice(key)).catch(() => {});
                        _ssDeviceReleaseBarrier = Promise.allSettled([_ssDeviceReleaseBarrier, p]);
                    }
                }
                panel.detectDeviceName = '';
            }
            // Immediate restart — keep extra-device bindings + main-detector
            // suppression (a transient teardown), same as rebuildLayout(). try/finally
            // so a throw can't leave the flag stuck true (which would make the next
            // REAL stop skip device + main-detector cleanup).
            _ssTransientTeardown = true;
            try { teardownPanels(); } finally { _ssTransientTeardown = false; }
            startSplitScreen(null, savedPrefs);
        }
    }

    // Called from the popup when the user clicks Dock. Posts the panel's
    // current state back to the main window, then closes. Sets _followerDocking
    // so the beforeunload handler skips the redundant `closed` post — `docked`
    // already tells the main to re-instate the panel, and a trailing `closed`
    // could race ahead of a deferred _redockPanel and drop the popups entry.
    function dockFollowerPanel(panel) {
        if (!FOLLOWER) return;
        _followerDocking = true;
        try {
            const ch = _ssChannel();
            if (ch) {
                ch.postMessage({
                    type: 'docked',
                    popupId: FOLLOWER.popupId,
                    finalState: _captureFollowerConfig(panel),
                });
            }
        } catch (_) {}
        try { window.close(); } catch (_) {}
    }

    // ── Main toggle ──
    function rebuildLayout() {
        // A start is in flight (e.g. user changed the layout select while the
        // initial start was awaiting _vizPluginsReady). Tearing down now would
        // race the in-flight panel-build; defer until the start finishes and
        // its `finally` block re-fires us.
        if (_starting) {
            _pendingRebuild = true;
            return;
        }
        const wasActive = active;
        const savedPrefs = wasActive ? captureCurrentPrefs() : null;
        // Mark this teardown as transient (a rebuild restarts immediately): keep the
        // extra-device bindings + main-detector suppression so we don't churn/rebind
        // the interfaces. Only gates the synchronous teardownPanels() below.
        _ssTransientTeardown = wasActive;
        try { teardownPanels(); } finally { _ssTransientTeardown = false; }
        if (wasActive) startSplitScreen(null, savedPrefs);
    }

    function captureCurrentPrefs() {
        return panels.map(panelToPrefs);
    }

    async function startSplitScreen(existingArrangements, savedPrefs) {
        // Re-entrancy guard: prevent concurrent starts from double-clicks,
        // layout rebuilds, or auto-reactivate firing while a start is in flight.
        if (_starting || active) return;
        _starting = true;
        try {
        await _vizPluginsReady;

        const info = highway.getSongInfo();
        if (info && info.arrangements) {
            arrangements = info.arrangements;
        }
        if (arrangements.length === 0) return;

        // If no explicit arrangements or prefs passed, try loading from storage
        if (!existingArrangements && !savedPrefs) {
            savedPrefs = migratePanelPrefs(loadPanelPrefs());
        }

        const cfg = LAYOUTS[layout];
        const container = createWrap();
        applyLayoutStyle(container, layout);

        // Determine arrangements for each panel
        let arrDefaults;
        if (existingArrangements && existingArrangements.length >= cfg.panels) {
            arrDefaults = existingArrangements.slice(0, cfg.panels);
        } else if (savedPrefs && savedPrefs.length > 0) {
            arrDefaults = [];
            for (let i = 0; i < cfg.panels; i++) {
                const pref = savedPrefs[i % savedPrefs.length];
                if (pref && pref.arrName === LYRICS_VALUE) {
                    arrDefaults.push(0);
                } else if (pref && pref.arrName?.startsWith(JUMPING_TAB_VALUE)) {
                    const jtArrName = pref.arrName.slice(JUMPING_TAB_VALUE.length + 1);
                    const jtIdx = resolveArrIndex(jtArrName);
                    arrDefaults.push(jtIdx >= 0 ? jtIdx : 0);
                } else if (pref && pref.arrName?.startsWith(VIZ_PREFIX + ':')) {
                    const parts = pref.arrName.split(':');
                    const vizArrName = parts.slice(2).join(':');
                    const vizIdx = resolveArrIndex(vizArrName);
                    arrDefaults.push(vizIdx >= 0 ? vizIdx : 0);
                } else {
                    const idx = pref ? resolveArrIndex(pref.arrName) : -1;
                    arrDefaults.push(idx >= 0 ? idx : getDefaultArrangements(1)[0]);
                }
            }
        } else {
            arrDefaults = getDefaultArrangements(cfg.panels);
        }

        // Flip active BEFORE the panel-init loop. initPanel may install a
        // viz renderer (e.g. piano) whose init() calls back into
        // window.slopsmithSplitscreen.panelChromeFor() / settingsAnchorFor().
        // Those gate on isActive(); if active flips true only after the loop,
        // the renderer mounts to #player (main-player fast path) on the first
        // entry and is stuck full-screen until the next start cycle.
        active = true;
        try { localStorage.setItem('splitscreenActive', 'true'); } catch (_) {}
        focusedPanelIdx = 0;

        // Silence the MAIN-PLAYER note detector while split mode owns detection —
        // otherwise its HUD + score render on top of P1 (the panel reusing the
        // main-player slot), showing a confusing second percentage/streak. Remember
        // whether it was on so teardown can restore it.
        try {
            // Suppress the singleton (blocks its auto-enable / re-arm AND tears down an
            // already-running session). Skip when split ALREADY owns detection — a
            // rebuild keeps suppression on across teardown, and re-capturing here would
            // read the (now-disabled) singleton as off and lose the real "was on" state
            // we must restore on the eventual real stop. Gate on our OWN flag, not
            // note_detect's internal one. CAPTURE the on-state BEFORE suppressing, since
            // _ssSetDefaultSuppressed(true) now disables the singleton itself.
            if (!_ssDetectSuppressed) {
                const nd = (typeof window !== 'undefined') ? window.noteDetect : null;
                _ssMainDetectWasOn = !!(nd && typeof nd.isEnabled === 'function' && nd.isEnabled());
                _ssSetDefaultSuppressed(true);
                _ssDetectSuppressed = true;
            }
        } catch (_) { /* keep prior _ssMainDetectWasOn */ }

        // Size the wrap NOW so panelDivs have a real rect during initPanel.
        // sizeCanvases() runs at end of start, but viz renderers (piano,
        // drums) measure panelChrome.clientWidth/Height in their init() —
        // a wrap with no `bottom` set has height:auto = 0 → panelDiv 50%
        // of 0 = 0 → renderer's bitmap = 0x0 → CSS upscales = pixelated.
        const initialChrome = document.getElementById('player-footer')
            || document.getElementById('player-controls');
        const initialControlsH = initialChrome ? initialChrome.offsetHeight : 0;
        container.style.bottom = initialControlsH + 'px';

        for (let i = 0; i < cfg.panels; i++) {
            const parts = createPanel(i, container, layout);
            const hw = createHighway();
            const panel = Object.assign({ hw, arrIndex: 0 }, parts);

            // Override resize BEFORE init — highway's default sizes to full window,
            // which clobbers all panels to overlap. Size to parent panel instead.
            hw.resize = function () {
                const c = panel.canvas;
                if (!c) return;
                const rect = panel.panelDiv.getBoundingClientRect();
                const barH = panel.bar.style.display === 'none' ? 0 : (panel.bar.offsetHeight || 28);
                const w = rect.width;
                const h = Math.max(0, rect.height - barH);
                c.style.width = w + 'px';
                c.style.height = h + 'px';
                const scale = hw.getRenderScale();
                c.width = Math.round(w * scale);
                c.height = Math.round(h * scale);
            };

            panels.push(panel);
            const panelPrefs = savedPrefs ? savedPrefs[i % savedPrefs.length] : null;
            initPanel(panel, arrDefaults[i], panelPrefs);
            panel.barToggleBtn.onclick = () => togglePanelBar(panel);
            if (panelPrefs?.barHidden) togglePanelBar(panel);
        }

        // Hide default highway canvas, ensure controls stay on top and at bottom.
        // Core detects the hide via canvas.offsetParent === null (slopsmith#246):
        // it pauses the main highway's rAF draw AND emits `highway:visibility`
        // on window.slopsmith. Viz renderers that mount sibling DOM — e.g. 3D
        // Highway's .h3d-wrap overlay, a sibling of #highway that display:none
        // on the canvas alone doesn't cover — subscribe to that event and hide
        // their own overlays. Splitscreen no longer reaches into other plugins'
        // DOM to do this; it just hides #highway and lets the contract handle
        // the rest (on stop, restoring #highway re-emits visible → overlays
        // re-show themselves).
        const defaultCanvas = document.getElementById('highway');
        if (defaultCanvas) defaultCanvas.style.display = 'none';
        const controls = document.getElementById('player-controls');
        // Legacy only: forcing position/z-index/margin on the classic controls
        // bar keeps it above the highway canvas. In v3 #player-controls is the
        // host's auto-hiding transport (its own positioning/z-index), so this
        // override would corrupt the v3 chrome — skip it there.
        if (controls && !_ssIsV3()) {
            controls.style.position = 'relative';  // Required for z-index to work
            controls.style.zIndex = '10';
            controls.style.marginTop = 'auto';
        }

        sizeCanvases();
        // Paint focus border + notify any listeners that registered during
        // the per-panel init pass (piano subscribes from its init()).
        _applyFocusBorder();
        _emitFocusChange();
        updateBtn();
        setRedundantControlsHidden(true);
        // HUD: visible while loaded; fades out when audio begins playback.
        const audio = document.getElementById('audio');
        if (audio && !audio.paused) fadeOutHud();
        else showHud();
        savePanelPrefs();

        if (localStorage.getItem('splitscreenControlsHidden') === 'true') toggleControlsVisibility();

        // Hook into the time sync loop
        startTimeSync();
        } catch (err) {
            // Rollback any partial state so the UI doesn't get stuck with
            // active=true, default highway hidden, and no panels — that's
            // the worst case (nothing renders, Split button thinks split is
            // running, toggle is now a no-op). teardownPanels handles the
            // active flip + plugin destroy; mirror stopSplitScreen for the
            // rest of the chrome resets so a partially-applied "split mode"
            // doesn't survive the failure.
            console.error('startSplitScreen failed:', err);
            teardownPanels();
            setRedundantControlsHidden(false);
            restoreHud();
            const defaultCanvas = document.getElementById('highway');
            if (defaultCanvas) defaultCanvas.style.display = '';
            const controls = document.getElementById('player-controls');
            if (controls) {
                if (controlsHidden) controls.style.display = '';
                // Legacy only — never write transport styling in v3 (matches the
                // gated override in startSplitScreen / injectBtn).
                if (!_ssIsV3()) {
                    controls.style.zIndex = '10';
                    controls.style.marginTop = '';
                }
            }
            controlsHidden = false;
            if (floatBtn) floatBtn.style.display = 'none';
            updateBtn();
            stopTimeSync();
        } finally {
            _starting = false;
            // Drain redock requests that arrived mid-start (popup's `docked`
            // message). Each _redockPanel re-enters startSplitScreen (setting
            // _starting), whose own finally drains the rest — so stop here as
            // soon as _starting flips, to avoid re-queuing into an infinite
            // loop. Do this BEFORE the rebuild drain so a queued layout change
            // reflows the final panel set including the redocked one.
            while (_pendingRedocks.length && !_starting) {
                const r = _pendingRedocks.shift();
                _redockPanel(r.popupId, r.finalState);
            }
            // Drain a queued rebuild from rebuildLayout. Only fire if the
            // session is still active — a failed start above already did
            // a full teardown, in which case there's nothing to rebuild.
            if (_pendingRebuild) {
                _pendingRebuild = false;
                if (active) rebuildLayout();
            }
        }
    }

    function stopSplitScreen() {
        savePanelPrefs();
        teardownPanels();  // flips active=false + emits focus change
        // Defensive clear at full-session-end. Well-behaved plugins
        // unsubscribe from offFocusChange in their renderer.destroy(),
        // which runs above as part of teardownPanels. A plugin that
        // forgets would otherwise accumulate stale callbacks across
        // sessions; clearing here bounds the leak to the lifetime of
        // a single split session.
        focusListeners.clear();
        setRedundantControlsHidden(false);
        restoreHud();

        // Restore default highway canvas (core re-emits `highway:visibility` →
        // sibling-mounting viz overlays like 3D Highway's .h3d-wrap re-show
        // themselves; see slopsmith#246) and controls z-index
        const defaultCanvas = document.getElementById('highway');
        if (defaultCanvas) defaultCanvas.style.display = '';
        const controls = document.getElementById('player-controls');
        if (controls) {
            if (controlsHidden) controls.style.display = '';
            // Legacy only — never write transport styling in v3.
            if (!_ssIsV3()) {
              controls.style.zIndex = '10';  // keep controls above highway canvas at all times
              controls.style.marginTop = '';
            }
        }
        controlsHidden = false;

        updateBtn();
        stopTimeSync();
    }

    function toggle() {
        if (_starting) return; // treat in-flight start as already active
        if (active) {
            // User-intent off — persist so navigation-driven stops (song
            // switch, leaving player) don't erase the user's on-state.
            try { localStorage.setItem('splitscreenActive', 'false'); } catch (_) {}
            stopSplitScreen();
        } else {
            startSplitScreen();
        }
    }

    // ── Time sync ──
    let syncInterval = null;

    function startTimeSync() {
        stopTimeSync();
        const audio = document.getElementById('audio');
        syncInterval = setInterval(() => {
            if (!audio || !active) return;
            const t = audio.currentTime;
            for (const p of panels) {
                if (!p.lyricsMode && !p.jumpingTabMode) p.hw.setTime(t);
            }
        }, 1000 / 60);
    }

    function stopTimeSync() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    }

    // ── Popup time broadcaster ──
    // Broadcasts audio.currentTime over BroadcastChannel whenever there is
    // at least one popped-out panel listening. Runs INDEPENDENTLY of the
    // splitscreen sync loop above — the user can pop the only panel out,
    // main goes back to the default highway view, and the popup still
    // receives time updates. Started when the first popup is registered;
    // stopped when the last popup is dropped.
    let _popupBroadcastInterval = null;
    // Last value we actually broadcast. Used to skip redundant messages while
    // the main audio is paused. Reset to null (force a re-broadcast next tick)
    // when a new popup registers and when the broadcaster stops — see
    // popOutPanel / _stopPopupBroadcaster.
    let _lastBroadcastTime = null;
    function _startPopupBroadcaster() {
        if (_popupBroadcastInterval) return;
        const audio = document.getElementById('audio');
        const ch = _ssChannel();
        if (!audio || !ch) return;
        _popupBroadcastInterval = setInterval(() => {
            // Reap popups that vanished without firing beforeunload (crash /
            // forced close / OS kill): otherwise their slot lingers and we'd
            // keep broadcasting to nobody at 60 Hz indefinitely. popup.closed
            // is a cheap same-origin boolean.
            for (const [id, e] of popups) {
                if (e.popup && e.popup.closed) popups.delete(id);
            }
            if (popups.size === 0) { _stopPopupBroadcaster(); return; }
            // Only broadcast when the playhead actually moved — skips ~60
            // redundant structured-clone messages/sec (and the follower's
            // per-panel setTime + toast checks) while the main audio is paused.
            // During playback currentTime advances every frame so this is a
            // no-op there. NaN can appear briefly during a src swap; never
            // broadcast that.
            const t = audio.currentTime;
            if (Number.isFinite(t) && t !== _lastBroadcastTime) {
                _lastBroadcastTime = t;
                // Carry the play/pause state on every tick — cheap, and it
                // means a freshly-opened popup learns it from the first
                // message instead of waiting for a play/pause transition.
                ch.postMessage({ type: 'time', t, playing: !audio.paused });
            }
        }, 1000 / 60);
    }
    function _stopPopupBroadcaster() {
        if (_popupBroadcastInterval) {
            clearInterval(_popupBroadcastInterval);
            _popupBroadcastInterval = null;
        }
        _lastBroadcastTime = null;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Main-window broadcaster / listener for popped-out panels
    // ══════════════════════════════════════════════════════════════════════
    let _mainChannelListenerAttached = false;
    // Broadcast the current play/pause state to any popups so they can pause
    // their time extrapolation precisely (instead of relying solely on the
    // "audio time stopped advancing" heuristic + backstop). Best-effort: in
    // JUCE mode the <audio> element's play/pause events may not fire — the
    // follower's heuristic still covers that case.
    function _broadcastMainPlayState() {
        try {
            const ch = _ssChannel();
            if (!ch || !popups.size) return;
            const audio = document.getElementById('audio');
            ch.postMessage({ type: 'playstate', playing: !!(audio && !audio.paused) });
        } catch (_) {}
    }
    function _ensureMainBroadcasterAndListener() {
        if (FOLLOWER) return;            // never run in popup
        const ch = _ssChannel();
        if (!ch || _mainChannelListenerAttached) return;
        _mainChannelListenerAttached = true;
        ch.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'docked' && msg.popupId && popups.has(msg.popupId)) {
                _redockPanel(msg.popupId, msg.finalState || null);
            } else if (msg.type === 'closed' && msg.popupId && popups.has(msg.popupId)) {
                // Popup was closed without an explicit Dock click. Treat
                // the panel as removed; don't re-add. Just drop the entry —
                // unless a redock for it is already queued (a `docked` arrived
                // while a start was in flight). The popup suppresses this post
                // when docking, so that only happens with an older popup build;
                // belt-and-suspenders.
                if (!_pendingRedocks.some(r => r.popupId === msg.popupId)) {
                    popups.delete(msg.popupId);
                }
            }
        };
        const audio = document.getElementById('audio');
        if (audio) {
            audio.addEventListener('play', _broadcastMainPlayState);
            audio.addEventListener('pause', _broadcastMainPlayState);
        }
    }

    // Re-instate a panel that was popped out, using the original config
    // we captured at pop-out time, overlaid with anything the popup told
    // us via `finalState`.
    function _redockPanel(popupId, finalState) {
        // A start (e.g. the rebuild that follows a pop-out) is in flight —
        // tearing down now would race the in-flight panel build. Queue it;
        // startSplitScreen's finally drains _pendingRedocks. Don't delete
        // the popups entry yet — the deferred call needs it.
        if (_starting) { _pendingRedocks.push({ popupId, finalState }); return; }
        const entry = popups.get(popupId);
        if (!entry) return;
        popups.delete(popupId);
        if (!currentFilename) return;

        // Decide where to slot the redocked panel back. If split is currently
        // active, capture the running prefs and append; otherwise start split
        // fresh with just this one panel.
        const merged = Object.assign({}, entry.originalConfig, finalState || {});
        const arrName = _modeToArrName(merged.mode, arrangements[merged.arrangement]?.name || '');
        const newPrefs = {
            arrName,
            // Restore the per-panel toggles captured at pop-out time (and
            // optionally overlaid with whatever the popup last reported via
            // finalState) instead of forcing fresh defaults.
            lyrics: !!merged.lyrics,
            inverted: !!merged.inverted,
            lefty: !!merged.lefty,
            detectChannel: merged.detectChannel || 'mono',
            detectDeviceName: merged.detectDeviceName || '',
            detectVerifierOffsetMs: Number.isFinite(merged.detectVerifierOffsetMs) ? merged.detectVerifierOffsetMs : 0,
            barHidden: !!merged.barHidden,
            mastery: Number.isFinite(merged.mastery) ? merged.mastery : 1,
        };

        let savedPrefs;
        if (active) {
            savedPrefs = captureCurrentPrefs();
            savedPrefs.push(newPrefs);
        } else {
            savedPrefs = [newPrefs];
        }

        if (active) {
            // Immediate restart — transient teardown (keep device bindings + main
            // suppression) so docking a panel back doesn't churn the interfaces.
            // try/finally so a throw can't strand the flag true.
            _ssTransientTeardown = true;
            try { teardownPanels(); } finally { _ssTransientTeardown = false; }
            startSplitScreen(null, savedPrefs);
        } else {
            startSplitScreen(null, savedPrefs);
        }
    }

    // ── Layout cycle button ──
    let layoutBtn = null;

    function createLayoutBtn() {
        if (layoutBtn) return layoutBtn;
        const slot = _ssPlayerControlSlot();
        const c = slot || document.getElementById('player-controls');
        if (!c) return null;
        if (_ssIsV3() && !slot) return null;  // v3 mounts exclusively into the slot
        const separator = _ssIsV3() ? null : c.querySelector('span.text-gray-700');
        layoutBtn = document.createElement('select');
        layoutBtn.id = 'splitscreen-layout-btn';
        layoutBtn.style.cssText =
            'background:#1a1a2e;border:1px solid #333;border-radius:6px;' +
            'padding:3px 6px;font-size:11px;color:#9ca3af;outline:none;display:none;';
        const options = [
            { value: 'top-bottom',  label: '⬒ Top/Bottom' },
            { value: 'left-right',  label: '⬓ Left/Right' },
            { value: 'tri-top',     label: '⊤ 1+2' },
            { value: 'tri-bottom',  label: '⊥ 2+1' },
            { value: 'quad',        label: '⊞ Quad' },
        ];
        for (const o of options) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            if (o.value === layout) opt.selected = true;
            layoutBtn.appendChild(opt);
        }
        layoutBtn.onchange = () => {
            layout = layoutBtn.value;
            localStorage.setItem('splitscreenLayout', layout);
            if (active) rebuildLayout();
        };
        if (separator) c.insertBefore(layoutBtn, separator);
        else c.appendChild(layoutBtn);
        return layoutBtn;
    }

    // ── Player HUD fade (top-left song title fades out once playback begins) ──
    function showHud() {
        const hud = document.getElementById('player-hud');
        if (!hud) return;
        hud.style.transition = 'none';
        hud.style.opacity = '1';
    }

    function fadeOutHud() {
        const hud = document.getElementById('player-hud');
        if (!hud) return;
        hud.style.transition = 'opacity 1.5s ease-out';
        hud.style.opacity = '0';
    }

    function restoreHud() {
        const hud = document.getElementById('player-hud');
        if (!hud) return;
        hud.style.transition = '';
        hud.style.opacity = '';
    }

    function onAudioPlay() {
        if (active) fadeOutHud();
    }

    const _audio = document.getElementById('audio');
    if (_audio) _audio.addEventListener('play', onAudioPlay);

    // ── Redundant main-bar controls (hidden while split is active because each
    // panel exposes its own arrangement / mastery / lyrics / viz controls) ──
    const REDUNDANT_CONTROL_IDS = [
        'arr-select',
        'mastery-slider-label',
        'mastery-slider',
        'mastery-label',
        'btn-lyrics',
        'viz-picker-label',
        'viz-picker',
    ];

    function setRedundantControlsHidden(hide) {
        for (const id of REDUNDANT_CONTROL_IDS) {
            const el = document.getElementById(id);
            if (el) el.style.display = hide ? 'none' : '';
        }
    }

    // ── Hide/show controls bar ──
    let hideBtn = null;
    let floatBtn = null;

    function createHideBtn() {
        if (hideBtn) return hideBtn;
        const slot = _ssPlayerControlSlot();
        const c = slot || document.getElementById('player-controls');
        if (!c) return null;
        if (_ssIsV3() && !slot) return null;  // v3 mounts exclusively into the slot
        hideBtn = document.createElement('button');
        hideBtn.id = 'btn-splitscreen-hide-bar';
        hideBtn.className = OFF_CLASS;
        hideBtn.title = 'Hide controls bar';
        hideBtn.style.display = 'none';
        hideBtn.onclick = toggleControlsVisibility;
        const closeBtn = c.querySelector('button[onclick*="showScreen"]');
        if (closeBtn) {
            closeBtn.classList.remove('ml-auto');
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;gap:8px;margin-left:auto;align-items:center;';
            c.insertBefore(wrapper, closeBtn);
            wrapper.appendChild(hideBtn);
            wrapper.appendChild(closeBtn);
        } else {
            c.appendChild(hideBtn);
        }
        return hideBtn;
    }

    function createFloatingShowBtn() {
        if (floatBtn) return floatBtn;
        const player = document.getElementById('player');
        if (!player) return null;
        floatBtn = document.createElement('button');
        floatBtn.id = 'btn-splitscreen-float-controls';
        floatBtn.textContent = '▴ Controls';
        floatBtn.title = 'Show controls bar';
        floatBtn.style.cssText =
            'position:absolute;bottom:8px;right:8px;z-index:20;display:none;' +
            'padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;' +
            'background:rgba(64,128,224,0.85);color:#fff;border:none;';
        floatBtn.onclick = toggleControlsVisibility;
        player.appendChild(floatBtn);
        return floatBtn;
    }

    function togglePanelBar(panel) {
        const hiding = panel.bar.style.display !== 'none';
        panel.bar.style.display = hiding ? 'none' : '';
        // The viz popover is anchored to the bar's height — close it when the
        // bar goes away (its trigger button is in the bar anyway).
        if (panel.vizPopover) panel.vizPopover.style.display = 'none';
        if (hiding) {
            panel.barToggleBtn.textContent = '▴ Bar';
            panel.barToggleBtn.title = 'Show panel controls';
            panel.barToggleBtn.style.background = 'rgba(64,128,224,0.85)';
            panel.barToggleBtn.style.color = '#fff';
            panel.barToggleBtn.style.width = 'auto';
            panel.barToggleBtn.style.padding = '0 6px';
        } else {
            panel.barToggleBtn.textContent = '▾';
            panel.barToggleBtn.title = 'Hide panel controls';
            panel.barToggleBtn.style.background = 'rgba(64,128,224,0.85)';
            panel.barToggleBtn.style.color = '#fff';
            panel.barToggleBtn.style.width = '';
            panel.barToggleBtn.style.padding = '2px 6px';
        }
        if (panel.jumpingTabMode && panel.jumpingTabPane) {
            panel.jumpingTabPane.resize();
        } else if (!panel.lyricsMode) {
            panel.hw.resize();
        }
        savePanelPrefs();
    }

    function toggleControlsVisibility() {
        controlsHidden = !controlsHidden;
        localStorage.setItem('splitscreenControlsHidden', controlsHidden);
        const controls = document.getElementById('player-controls');
        if (controls) controls.style.display = controlsHidden ? 'none' : '';
        if (active) sizeCanvases();
        updateBtn();
    }

    // ── Toggle button ──
    function updateBtn() {
        const btn = document.getElementById('btn-splitscreen');
        if (btn) btn.className = active ? ON_CLASS : OFF_CLASS;
        if (layoutBtn) layoutBtn.style.display = active ? '' : 'none';
        if (hideBtn) {
            hideBtn.style.display = active ? '' : 'none';
            hideBtn.textContent = controlsHidden ? '▴ Bar' : '▾ Bar';
        }
        if (floatBtn) floatBtn.style.display = (active && controlsHidden) ? '' : 'none';
    }

    function injectBtn() {
        // v3: mount split-screen controls into the host's stable plugin-control
        // slot (Plugins rail popover). In v3 the slot is always present, so the
        // legacy separator anchor and the #player-controls z-index/position
        // override (which would corrupt the v3 transport layout) are skipped.
        const slot = _ssPlayerControlSlot();
        const c = slot || document.getElementById('player-controls');
        if (!c) return;
        if (_ssIsV3() && !slot) return;  // v3 mounts exclusively into the slot
        if (!_ssIsV3()) {
            // Keep controls above highway/3D canvas at all times regardless of split state.
            c.style.position = 'relative';
            c.style.zIndex = '10';
        }
        if (document.getElementById('btn-splitscreen')) return;
        const separator = _ssIsV3() ? null : c.querySelector('span.text-gray-700');
        const b = document.createElement('button');
        b.id = 'btn-splitscreen';
        b.className = OFF_CLASS;
        b.textContent = 'Split';
        b.title = 'Toggle split-screen multiplayer view';
        b.onclick = toggle;
        if (separator) c.insertBefore(b, separator);
        else c.appendChild(b);
        createLayoutBtn();
        createHideBtn();
        createFloatingShowBtn();
    }

    // ── Resize handler ──
    // sizeCanvases() is for main-window splitscreen — it reads the global
    // #player-controls height to compute the wrap's bottom offset. In a
    // popup #player-controls is force-hidden, so offsetHeight is 0 and
    // sizeCanvases would clobber the follower wrap's `bottom: FOLLOWER_TOOLBAR_H`
    // reservation, sliding the wrap (and every panel's bar) under the
    // follower toolbar. Follower mode has its own resize handler in
    // bootFollowerMode that resizes panels without touching the wrap.
    window.addEventListener('resize', () => {
        if (active && !FOLLOWER) sizeCanvases();
    });

    // Tell any popped-out panels the main window is going away so they stop
    // syncing (and stop their highway rAF loops) and show a notice instead of
    // freezing silently. Best-effort — beforeunload BroadcastChannel posts
    // aren't guaranteed to flush; the popup's own state stays the floor.
    if (!FOLLOWER) {
        window.addEventListener('beforeunload', () => {
            try {
                const c = _ssChannel();
                if (c && popups.size) c.postMessage({ type: 'main-closed' });
            } catch (_) {}
        });
    }

    // ── Hook into playSong ──
    const _play = window.playSong;
    window.playSong = async function (f, a) {
        // Mount the Split button (and its siblings) BEFORE awaiting the
        // upstream chain. Any upstream playSong wrapper that throws (e.g.
        // capo failing in its v3 insertBefore — seen in the wild on the
        // v3 #player-controls) would otherwise reject this await and skip
        // the trailing `injectBtn()` call, leaving the v3 Plugins rail
        // popover empty. Keep the trailing call too so a wrapper that
        // rebuilds #player-controls (v2 behaviour) still re-injects.
        if (!FOLLOWER) injectBtn();
        // Capture the filename eagerly for the same reason — when an
        // upstream wrapper throws, the `currentFilename = f` assignment
        // below the await is skipped and panel WS connections open with
        // `null` (server logs the request as /ws/highway/null and replies
        // {"error":"File not found"}, closing the panel). Setting it here
        // makes panel construction work even with a throwing wrapper; the
        // post-await reassignment stays as a no-op same-value write.
        currentFilename = f;
        // OR in persisted active flag so split state carries across page
        // loads — without this, `active` resets to false on reload and the
        // user's prior split session is forgotten.
        const wasActive = active || localStorage.getItem('splitscreenActive') === 'true';
        // In a follower window, never auto-stop split — the follower panel IS
        // the only thing on screen, and we drive its setup ourselves.
        if (!FOLLOWER && active) stopSplitScreen();
        await _play(f, a);

        currentFilename = f;

        // Try to grab arrangements eagerly via _onReady, but also poll as
        // a fallback — async plugins (e.g. 3dhighway) can cause the 'ready'
        // WS message to fire before _onReady is set, so we can't rely on it.
        const origOnReady = highway._onReady;
        let handled = false;
        highway._onReady = () => {
            const info = highway.getSongInfo();
            if (info && info.arrangements) {
                arrangements = info.arrangements;
            }
            if (origOnReady) origOnReady();
            highway._onReady = null;

            // Auto-follow: notify any popped-out panels that the song just
            // changed so they can swap to the new chart in their current
            // mode + arrangement. Only the main window broadcasts; FOLLOWER
            // windows skip this.
            if (!FOLLOWER && popups.size > 0 && ssChannel) {
                ssChannel.postMessage({ type: 'song-changed', filename: currentFilename });
            }

            if (!handled && !FOLLOWER && (alwaysSplit || wasActive)) {
                handled = true;
                startSplitScreen();
            }
        };

        // Fallback: poll for song info in case _onReady was missed
        if (!FOLLOWER && (alwaysSplit || wasActive)) {
            let attempts = 0;
            const poll = setInterval(() => {
                attempts++;
                if (handled || attempts > 30) { clearInterval(poll); return; }
                const info = highway.getSongInfo();
                if (info && info.arrangements && info.arrangements.length) {
                    clearInterval(poll);
                    if (!handled) {
                        handled = true;
                        arrangements = info.arrangements;
                        startSplitScreen();
                    }
                }
            }, 200);
        }

        if (!FOLLOWER) injectBtn();
    };

    // Clean up on screen change. In follower mode the popup never navigates
    // away from the player, but if something tries we don't tear down split
    // (the follower panel IS the player).
    const _show = window.showScreen;
    window.showScreen = function (id) {
        if (!FOLLOWER && id !== 'player' && active) stopSplitScreen();
        _show(id);
    };

    // ══════════════════════════════════════════════════════════════════════
    //  Follower-mode bootstrap (popup window only)
    //  The actual `if (FOLLOWER) bootFollowerMode();` invocation is at the
    //  bottom of this IIFE — all the `let` bindings the function references
    //  (especially _followerAudio) must be past their TDZ before we call it.
    // ══════════════════════════════════════════════════════════════════════

    // ── Follower clock + rebuild state ────────────────────────────────────
    // In follower mode the popup's local <audio> element is muted AND paused
    // (we never surface a play button, can't reliably autoplay, and don't
    // want it decoding audio nobody hears). Lyrics pane, jumping tab pane,
    // and the highway's time-driven helpers all read `audio.currentTime`
    // directly though — so we shim that property to the time broadcast from
    // the main window. _followerCurrentTime is that value; while the main
    // reports playback it's extrapolated forward with performance.now()
    // between broadcasts so scrolling stays smooth even if the main tab is
    // backgrounded and its 60 Hz broadcaster throttles to ~1 Hz.
    let _followerCurrentTime = 0;
    let _followerPlaying = false;          // last play/pause state inferred from the main window
    let _followerAnchorT = 0;              // broadcast time at the last `time` message
    let _followerAnchorPerf = 0;           // performance.now() at that message (0 = none yet)
    let _followerObservedRate = 1;         // audio-time-per-wall-second, from message deltas (speed slider)
    let _followerInterpRaf = null;         // rAF handle for the extrapolation loop
    let _followerOrphaned = false;         // true once the main window says it's closing
    let _followerDocking = false;          // true once dockFollowerPanel() ran — suppresses the redundant `closed` post on the ensuing beforeunload
    let _followerRebuildBusy = false;      // single-flight guard: song-change rebuild in progress
    let _followerPendingFilename = null;   // a song change that arrived while busy
    // Never extrapolate more than this far past the last `time` message — a
    // backstop in case a `playstate:false` (pause) message is dropped.
    const _FOLLOWER_MAX_EXTRAP_S = 2.0;

    function _installFollowerAudioShim(audio) {
        if (!audio) return;
        try {
            Object.defineProperty(audio, 'currentTime', {
                get() { return _followerCurrentTime; },
                set(_v) { /* ignore — popup audio is a follower */ },
                configurable: true,
            });
            // The element is actually paused (see below — we stop the needless
            // decode) but anything in the popup that gates animation on
            // `!audio.paused` should keep running: the follower is conceptually
            // always following the main playhead.
            Object.defineProperty(audio, 'paused', {
                get() { return false; },
                configurable: true,
            });
        } catch (e) {
            console.warn('[splitscreen-follower] failed to install audio shim:', e);
        }
    }

    // The <audio> element we've already attached the keep-paused `play`
    // listener to (so calling _silenceFollowerAudio repeatedly — boot + each
    // song change — doesn't stack listeners; also covers a hypothetical
    // element swap).
    let _followerPlayGuardEl = null;
    // Keep the popup's <audio> paused — and re-pause it whenever anything
    // calls .play() (autoplay, a src swap on song change). Mute alone leaves
    // it decoding the stream for nothing.
    function _silenceFollowerAudio(audio) {
        if (!audio) return;
        audio.muted = true;
        audio.volume = 0;
        try { audio.pause(); } catch (_) {}
        if (_followerPlayGuardEl !== audio) {
            _followerPlayGuardEl = audio;
            audio.addEventListener('play', () => { try { audio.pause(); } catch (_) {} });
        }
    }

    // rAF loop that advances _followerCurrentTime between `time` broadcasts
    // while the main window reports playback. Idempotent; cancelled on
    // orphan / unload.
    function _startFollowerInterp() {
        if (_followerInterpRaf != null) return;
        const tick = () => {
            _followerInterpRaf = requestAnimationFrame(tick);
            if (_followerOrphaned || !_followerPlaying || _followerAnchorPerf === 0) return;
            const wall = (performance.now() - _followerAnchorPerf) / 1000;
            if (wall > _FOLLOWER_MAX_EXTRAP_S) { _followerPlaying = false; return; }
            const est = _followerAnchorT + _followerObservedRate * wall;
            _followerCurrentTime = est;
            for (const p of panels) {
                if (!p.lyricsMode && !p.jumpingTabMode) p.hw.setTime(est);
            }
        };
        _followerInterpRaf = requestAnimationFrame(tick);
    }
    function _stopFollowerInterp() {
        if (_followerInterpRaf != null) { cancelAnimationFrame(_followerInterpRaf); _followerInterpRaf = null; }
    }

    // Handle a `time` broadcast: derive playback rate vs wall-time, re-anchor,
    // fan the value out to every panel highway.
    //
    // The most reliable "is it playing" signal is observing the broadcast
    // clock itself advance in real time (dT/dWall ≈ playbackRate) — that works
    // regardless of whether the main window's <audio>.paused is meaningful
    // (it isn't, in JUCE mode). The optional `playing` flag on the message is
    // only used to STOP extrapolating when the clock has also stalled: it lets
    // us tell "main paused" from "main tab throttled to ~1 Hz" within the gap
    // between messages, which the clock alone can't. The 2 s extrapolation
    // backstop covers the case where the flag is absent/unreliable.
    function _onFollowerTimeMessage(t, playing) {
        const nowP = performance.now();
        let advancedInRealtime = false;
        if (_followerAnchorPerf > 0) {
            const dWall = (nowP - _followerAnchorPerf) / 1000;
            const dT = t - _followerAnchorT;
            if (dT > 0 && dWall > 0.001) {
                const rate = dT / dWall;
                if (rate > 0.05 && rate < 5) {
                    _followerObservedRate = rate;
                    advancedInRealtime = true;          // audio time is moving → playing
                } else {
                    _followerObservedRate = 1;          // out-of-band (seek / loop wrap / long gap) — snap, don't extrapolate off it
                }
            } else if (dT < 0) {
                _followerObservedRate = 1;              // backward seek — snap
            }
            // dT === 0 → clock stalled (paused, or just no audio-frame refresh).
        }
        _followerAnchorT = t;
        _followerAnchorPerf = nowP;
        _followerCurrentTime = t;
        for (const p of panels) {
            if (!p.lyricsMode && !p.jumpingTabMode) p.hw.setTime(t);
        }
        if (advancedInRealtime || playing === true) {
            // Either the clock observably moved, or the main says it's playing
            // (audio.currentTime just hasn't refreshed yet) — extrapolate.
            _followerPlaying = true;
        } else if (playing === false) {
            // Clock didn't advance AND the main says it's paused → definitely
            // paused; stop extrapolating and park here.
            _followerPlaying = false;
        }
        // (no advance + playing undefined → old main build: leave _followerPlaying
        //  as-is; the backstop trips after _FOLLOWER_MAX_EXTRAP_S if it was a pause.)
        _maybeDismissFollowerToastOnPlay(t);
    }

    // Handle an explicit play/pause notice from the main window.
    function _onFollowerPlayState(playing) {
        _followerPlaying = playing;
        if (playing) {
            _followerAnchorPerf = performance.now();    // extrapolate from "now", not a stale anchor
        } else {
            // Snap every panel to the last known time so a half-extrapolated
            // frame doesn't linger on screen.
            for (const p of panels) {
                if (!p.lyricsMode && !p.jumpingTabMode) p.hw.setTime(_followerAnchorT);
            }
            _followerCurrentTime = _followerAnchorT;
        }
    }

    // The main window is closing — stop syncing, tear the panels down, and
    // tell the user. Idempotent.
    function _onFollowerOrphaned() {
        if (_followerOrphaned) return;
        _followerOrphaned = true;
        _stopFollowerInterp();
        try { teardownPanels(); } catch (_) {}   // also stops every panel highway / WS / rAF
        if (_followerToolbar) { try { _followerToolbar.remove(); } catch (_) {} _followerToolbar = null; }
        if (_followerToast) { try { _followerToast.remove(); } catch (_) {} _followerToast = null; }
        const o = document.createElement('div');
        o.id = 'follower-orphaned-overlay';
        o.style.cssText =
            'position:fixed;inset:0;z-index:100000;background:#0a0a14;color:#9ca3af;' +
            'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;' +
            'font-family:sans-serif;text-align:center;padding:24px;';
        const h = document.createElement('div');
        h.style.cssText = 'font-size:18px;font-weight:600;color:#e5e7eb;';
        h.textContent = 'Main Slopsmith window closed';
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:13px;';
        sub.textContent = 'This follower window is no longer synced — you can close it.';
        o.appendChild(h);
        o.appendChild(sub);
        document.body.appendChild(o);
    }

    // Cached reference to the popup's <audio> element so the song-change
    // handler can re-assert mute/pause + re-shim without re-querying.
    let _followerAudio = null;

    function bootFollowerMode() {
        // Hide non-panel chrome with a single CSS rule so we don't have to
        // chase every element id slopsmith renders. The follower wrap covers
        // the viewport at a high z-index; #player (and our wrap) stay visible.
        const style = document.createElement('style');
        style.textContent =
            'body.ss-follower #nav,' +
            'body.ss-follower header,' +
            'body.ss-follower .screen:not(#player),' +
            'body.ss-follower #player-controls,' +
            'body.ss-follower #player-hud,' +
            'body.ss-follower #section-map,' +
            'body.ss-follower #btn-splitscreen,' +
            'body.ss-follower #splitscreen-layout-btn,' +
            'body.ss-follower #btn-splitscreen-hide-bar,' +
            'body.ss-follower #btn-splitscreen-float-controls,' +
            // v3 (fee[dB]ack v0.3.0) chrome — sidebar, main content area
            // wrapper (which would render an empty stripe alongside the
            // player), v3 topbar (inside #v3-main but called out for
            // clarity), and the hover-reveal player rail + its popovers.
            // Follower windows show ONLY the panel canvas, nothing else.
            'body.ss-follower #v3-sidebar,' +
            'body.ss-follower #v3-main,' +
            'body.ss-follower #v3-topbar,' +
            'body.ss-follower #v3-railzone,' +
            'body.ss-follower [id^="v3-rail-pop-"]' +
            '{display:none !important;}' +
            'body.ss-follower #player{padding:0 !important;}' +
            // NB: we deliberately do NOT pin #player to the viewport here.
            // The follower's visible surface is `#splitscreen-wrap`, which
            // buildFollowerLayout appends directly to <body> (position:fixed,
            // z-index:9999) — see buildFollowerLayout. In v3 #player is a
            // descendant of the now-`display:none` #v3-main, so any rule on
            // #player produces no box regardless; in v2 the body-level wrap
            // already covers #player. Pinning #player was a no-op in v3 and
            // redundant in v2, so it's omitted to avoid implying the panel
            // canvas renders into #player (it doesn't).
            'body.ss-follower{margin:0;overflow:hidden;}';
        document.head.appendChild(style);
        document.body.classList.add('ss-follower');

        // Mute AND pause the popup's local audio (and keep it paused — see
        // _silenceFollowerAudio) — the follower never plays, it slaves to the
        // main window's currentTime via BroadcastChannel, and a muted-but-
        // playing element still decodes the stream for nothing.
        _followerAudio = document.getElementById('audio');
        _silenceFollowerAudio(_followerAudio);
        // Shim audio.currentTime (→ broadcast time) and audio.paused (→ false)
        // so the lyrics pane, jumping tab pane, etc. see the broadcast clock
        // and keep animating despite the underlying element being paused.
        _installFollowerAudioShim(_followerAudio);

        // Notify main when the popup is closed *without* docking, so the slot
        // isn't held open indefinitely. (When docking, dockFollowerPanel set
        // _followerDocking — the `docked` message already covers it and a
        // trailing `closed` could clobber a deferred redock.) Registered once;
        // survives song-change rebuilds.
        window.addEventListener('beforeunload', () => {
            _stopFollowerInterp();
            if (_followerDocking) return;
            try {
                const c = _ssChannel();
                if (c) c.postMessage({ type: 'closed', popupId: FOLLOWER.popupId });
            } catch (_) {}
        });

        // Start the between-broadcasts extrapolation loop (idempotent).
        _startFollowerInterp();

        // Resize handler: walk every live panel — multi-panel popups
        // (top-bottom, left-right, quad) need each highway / JT pane
        // resized, not just panels[0]. Mirrors sizeCanvases()'s loop
        // shape but doesn't touch wrap positioning (the follower wrap's
        // top/bottom are set once at build time and don't need to track
        // window chrome the way the main-window wrap does).
        window.addEventListener('resize', () => {
            for (const p of panels) {
                if (p.jumpingTabMode && p.jumpingTabPane) p.jumpingTabPane.resize();
                else if (!p.lyricsMode) p.hw.resize();
            }
        });

        // Wait one frame so all plugin IIFEs that loaded before us have
        // finished installing their playSong wraps and globals.
        requestAnimationFrame(() => {
            if (typeof window.showScreen === 'function') window.showScreen('player');
            loadSongInFollower(FOLLOWER.filename, [FOLLOWER]);
        });
    }

    // Load `filename` in the popup, wait for it to be ready, then build the
    // follower panels from `cfgs`. Used both on initial bootstrap
    // (cfgs = [FOLLOWER]) and on song-change (cfgs = current panel states).
    // The popup's main highway is shared across all panels for time / song
    // info purposes; per-panel arrangement is set inside each panel's own
    // WebSocket via initPanel.
    async function loadSongInFollower(filename, cfgs) {
        const firstArr = (cfgs[0] && cfgs[0].arrangement) || 0;
        try {
            await window.playSong(filename, firstArr);
        } catch (e) {
            // An upstream wrapper (e.g. capo's `_capoInjectBadge` failing on
            // v3 #player-controls) can throw AFTER the song's WebSocket has
            // already connected and the audio element's `src` has been set.
            // Bailing here used to leave the popup blank (no buildFollowerLayout
            // call → no panels, no per-panel bars). Log and keep going; the
            // real "song never loaded" case is caught by waitForHighwayReady
            // below, which surfaces a timeout instead of a silent blank.
            console.error('[splitscreen-follower] playSong wrapper threw (continuing):', e);
        }
        // Re-acquire the <audio> element, re-assert mute+pause (playSong resets
        // audio.src and may .play(); some browsers unmute on src change), and
        // re-install the shim. The element is normally the same instance so the
        // Object.defineProperty overrides persist, but re-querying + re-defining
        // (configurable:true → harmless redefine) keeps the shim correct even
        // if a future refactor swaps the element out.
        _followerAudio = document.getElementById('audio');
        _silenceFollowerAudio(_followerAudio);
        _installFollowerAudioShim(_followerAudio);
        await waitForHighwayReady();
        // Ensure viz plugin metadata is ready before buildFollowerLayout calls
        // populateSelect() — same guarantee startSplitScreen gives main panels.
        await _vizPluginsReady;
        // Honour the user's chosen layout (default 'follower' = single).
        // Pad cfgs with null so any extra slots get smart defaults inside
        // buildFollowerLayout.
        const needed = FOLLOWER_LAYOUT_PANELS[_followerLayoutKey] || 1;
        const padded = cfgs.slice();
        for (let i = padded.length; i < needed; i++) padded.push(null);
        buildFollowerLayout(padded, _followerLayoutKey);
        _buildFollowerToolbar();
    }

    function waitForHighwayReady() {
        return new Promise(resolve => {
            const info = highway.getSongInfo();
            if (info && info.arrangements && info.arrangements.length) {
                resolve();
                return;
            }
            const orig = highway._onReady;
            let resolved = false;
            highway._onReady = () => {
                if (orig) orig();
                highway._onReady = null;
                if (!resolved) { resolved = true; resolve(); }
            };
            let attempts = 0;
            const poll = setInterval(() => {
                attempts++;
                if (resolved || attempts > 60) { clearInterval(poll); if (!resolved) resolve(); return; }
                const i = highway.getSongInfo();
                if (i && i.arrangements && i.arrangements.length) {
                    clearInterval(poll);
                    if (!resolved) { resolved = true; resolve(); }
                }
            }, 100);
        });
    }

    // ── Follower layout state ─────────────────────────────────────────
    // The popup window can split itself the same way main can: 'follower'
    // (single full-window panel, default), 'top-bottom' (2 stacked),
    // 'left-right' (2 side-by-side), 'quad' (2x2). The layout is picked
    // from a selector in the popup's bottom toolbar.
    const FOLLOWER_LAYOUT_PANELS = {
        'follower':   1,
        'top-bottom': 2,
        'left-right': 2,
        'quad':       4,
    };
    let _followerLayoutKey = 'follower';
    const FOLLOWER_TOOLBAR_H = 32;

    // Convert a captured panel config (cfg) and arrIdx into the prefs
    // shape that initPanel expects.
    function _followerCfgToPrefs(cfg, arrIdx) {
        const arrName = _modeToArrName(cfg.mode, arrangements[arrIdx]?.name || '');
        return {
            arrName,
            // Use the captured per-panel toggles when present so the follower
            // window mirrors the source panel's lyrics/bar/detect state.
            // Older popups that didn't include these fields fall back to
            // sane defaults.
            lyrics: !!cfg.lyrics,
            inverted: !!cfg.inverted,
            lefty: !!cfg.lefty,
            detectChannel: cfg.detectChannel || 'mono',
            detectDeviceName: cfg.detectDeviceName || '',
            detectVerifierOffsetMs: Number.isFinite(cfg.detectVerifierOffsetMs) ? cfg.detectVerifierOffsetMs : 0,
            barHidden: !!cfg.barHidden,
            mastery: Number.isFinite(cfg.mastery) ? cfg.mastery : 1,
        };
    }

    // Build N panels per `layoutKey` into the wrap div. `cfgs` is an array
    // of panel configs (one per slot); slots beyond cfgs.length get smart
    // defaults via getDefaultArrangements. Replaces the older single-panel
    // buildFollowerPanel so the popup can host any of the standard layouts.
    function buildFollowerLayout(cfgs, layoutKey) {
        layoutKey = FOLLOWER_LAYOUT_PANELS[layoutKey] ? layoutKey : 'follower';
        _followerLayoutKey = layoutKey;
        const panelCount = FOLLOWER_LAYOUT_PANELS[layoutKey];

        const info = highway.getSongInfo();
        if (info && info.arrangements) arrangements = info.arrangements;

        // Build the full-viewport wrap. Reuse the #splitscreen-wrap id so
        // any selectors elsewhere find it identically. We leave room at
        // the bottom for the follower toolbar.
        //
        // Block layout for single-panel mode, flex for multi-panel. With
        // a single child at width/height: 100%, the flexbox algorithm
        // doesn't reliably resolve the main-axis size — height: 100%
        // can collapse to the child's content height. That made the
        // panelDiv bounding rect 0-tall on first measure, the bar
        // (position:absolute; bottom:0) got clipped by the panel's
        // overflow:hidden, and the per-panel control bar appeared
        // missing. Block positioning (matches the original
        // buildFollowerPanel behavior) sizes height: 100% against the
        // position:fixed parent's definite dimensions cleanly. Multi-
        // panel layouts use 50% sizes which the flex algorithm resolves
        // fine, so they keep the flex container.
        const followerWrap = document.createElement('div');
        followerWrap.id = 'splitscreen-wrap';
        followerWrap.style.cssText =
            'position:fixed;top:0;left:0;right:0;bottom:' + FOLLOWER_TOOLBAR_H + 'px;' +
            'background:#000;z-index:9999;';
        if (layoutKey === 'top-bottom') {
            followerWrap.style.display = 'flex';
            followerWrap.style.flexDirection = 'column';
        } else if (layoutKey === 'left-right') {
            followerWrap.style.display = 'flex';
            followerWrap.style.flexDirection = 'row';
        } else if (layoutKey === 'quad') {
            followerWrap.style.display = 'flex';
            followerWrap.style.flexDirection = 'row';
            followerWrap.style.flexWrap = 'wrap';
        }
        // else: single (follower) — leave as block layout (no flex).
        document.body.appendChild(followerWrap);
        wrap = followerWrap;

        // Smart-default arrangement indices for slots beyond the explicit
        // cfgs (e.g. when user widens 1 → 4, slots 1..3 get lead/rhythm/bass
        // assignments via the same helper main uses).
        const defaultArrs = getDefaultArrangements(panelCount);

        for (let i = 0; i < panelCount; i++) {
            // Pick the layoutKey passed to createPanel so panel sizing is
            // correct: 'follower' for single, otherwise the layout name.
            const panelLayoutKey = (panelCount === 1) ? 'follower' : layoutKey;
            const parts = createPanel(i, followerWrap, panelLayoutKey);
            const hw = createHighway();
            const panel = Object.assign({ hw, arrIndex: 0 }, parts);

            // Same hw.resize override pattern startSplitScreen() uses.
            hw.resize = function () {
                const c = panel.canvas;
                if (!c) return;
                const rect = panel.panelDiv.getBoundingClientRect();
                const barH = panel.bar.style.display === 'none' ? 0 : (panel.bar.offsetHeight || 28);
                const w = rect.width;
                const h = Math.max(0, rect.height - barH);
                c.style.width = w + 'px';
                c.style.height = h + 'px';
                const scale = hw.getRenderScale();
                c.width = Math.round(w * scale);
                c.height = Math.round(h * scale);
            };

            panels.push(panel);

            // Pick this slot's config: explicit if cfgs has it, else smart default.
            const cfg = cfgs[i] || {
                arrangement: defaultArrs[i] || 0,
                mode: '2d',
                inverted: 0,
                lefty: 0,
                mastery: 1,
            };
            const arrIdx = (cfg.arrangement >= 0 && cfg.arrangement < arrangements.length)
                ? cfg.arrangement : 0;
            initPanel(panel, arrIdx, _followerCfgToPrefs(cfg, arrIdx));

            // Wire the panel's bar-toggle button. startSplitScreen() does
            // this in main; follower-mode panels need the same hookup or
            // the per-panel ▾ Bar button is dead.
            panel.barToggleBtn.onclick = () => togglePanelBar(panel);
        }

        active = true;
        for (const p of panels) p.hw.resize();

        // Subscribe to the broadcast channel for time / playstate / song-change
        // / main-closed. Re-assigning `onmessage` on each rebuild replaces the
        // prior handler (no listener stacking); each handler reads the live
        // module-level `panels` so it always sees the current grid.
        const ch = _ssChannel();
        if (ch) {
            ch.onmessage = (ev) => {
                if (_followerOrphaned) return;
                const msg = ev.data || {};
                if (msg.type === 'time' && Number.isFinite(msg.t)) {
                    _onFollowerTimeMessage(msg.t, msg.playing);
                } else if (msg.type === 'playstate') {
                    _onFollowerPlayState(!!msg.playing);
                } else if (msg.type === 'main-closed') {
                    _onFollowerOrphaned();
                } else if (msg.type === 'song-changed' && msg.filename && msg.filename !== currentFilename) {
                    _handleFollowerSongChange(msg.filename);
                }
            };
        }
        // Make sure the extrapolation loop is running (cheap if already started
        // from bootFollowerMode; also covers a hypothetical rebuild before boot).
        _startFollowerInterp();
    }

    // Bottom toolbar inside the popup window: layout picker + dock-all.
    // Built once per popup, the layout selector triggers rebuild of the
    // panel grid.
    let _followerToolbar = null;
    function _buildFollowerToolbar() {
        if (_followerToolbar) return _followerToolbar;
        const bar = document.createElement('div');
        bar.id = 'follower-toolbar';
        bar.style.cssText =
            'position:fixed;bottom:0;left:0;right:0;height:' + FOLLOWER_TOOLBAR_H + 'px;' +
            'display:flex;align-items:center;gap:10px;padding:0 10px;' +
            'background:rgba(8,8,16,0.95);border-top:1px solid #1f2937;' +
            'z-index:10001;font-family:sans-serif;color:#9ca3af;font-size:12px;';

        const label = document.createElement('span');
        label.textContent = 'Layout';
        label.style.cssText = 'font-size:11px;color:#6b7280;';
        bar.appendChild(label);

        const sel = document.createElement('select');
        sel.id = 'follower-layout-select';
        sel.style.cssText =
            'background:#1a1a2e;border:1px solid #333;border-radius:4px;' +
            'padding:3px 6px;font-size:12px;color:#ccc;outline:none;';
        const options = [
            { value: 'follower',   label: '⬜ Single' },
            { value: 'top-bottom', label: '⬒ Top/Bottom' },
            { value: 'left-right', label: '⬓ Left/Right' },
            { value: 'quad',       label: '⊞ Quad' },
        ];
        for (const o of options) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            if (o.value === _followerLayoutKey) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.onchange = () => rebuildFollowerLayout(sel.value);
        bar.appendChild(sel);

        document.body.appendChild(bar);
        _followerToolbar = bar;
        return bar;
    }

    // Rebuild the popup's panel grid into a new layout. Captures the
    // current panels' configs so existing slots survive the change; new
    // slots fill with smart defaults via getDefaultArrangements.
    function rebuildFollowerLayout(newLayoutKey) {
        if (!FOLLOWER_LAYOUT_PANELS[newLayoutKey]) return;
        if (_followerRebuildBusy) {
            // A song-change rebuild is mid-flight (awaiting playSong / ready);
            // tearing down now would race it. Snap the picker back so the UI
            // doesn't lie; the user can re-pick once the song settles.
            const sel = document.getElementById('follower-layout-select');
            if (sel) sel.value = _followerLayoutKey;
            return;
        }
        if (newLayoutKey === _followerLayoutKey && panels.length === FOLLOWER_LAYOUT_PANELS[newLayoutKey]) return;

        // Capture current panel configs (in slot order) so the rebuilt
        // grid keeps existing arrangement / mode / inverted / lefty / mastery.
        const cfgs = panels.map(p => _captureFollowerConfig(p));

        teardownPanels();
        active = false;
        buildFollowerLayout(cfgs, newLayoutKey);
    }

    // Capture every popup panel's current state into an array of cfgs,
    // suitable for handing back to loadSongInFollower / buildFollowerLayout.
    // Reads from the live panels so any user changes since pop-out or
    // last layout change are honoured.
    function _captureAllFollowerConfigs() {
        return panels.map(p => _captureFollowerConfig(p));
    }

    // Rebuild the follower panels for a new song while preserving the
    // user's layout + per-panel mode + arrangement choices. Triggered by
    // the main window's `song-changed` broadcast. Single-flight: a change
    // arriving while one is in progress is coalesced — only the latest
    // pending filename runs after the current rebuild finishes.
    async function _handleFollowerSongChange(newFilename) {
        if (_followerOrphaned) return;
        if (_followerRebuildBusy) { _followerPendingFilename = newFilename; return; }
        _followerRebuildBusy = true;
        // Pause extrapolation during the rebuild — panels are being torn down
        // and rebuilt; the first `time` message for the new song re-arms it.
        _followerPlaying = false;
        _followerAnchorPerf = 0;
        try {
            const cfgs = _captureAllFollowerConfigs();
            teardownPanels();
            active = false;
            await loadSongInFollower(newFilename, cfgs);
            // Briefly surface what the new song is so the popup viewer
            // (often on a second monitor, away from the main window's HUD)
            // sees the title / artist / tuning / per-panel arrangement
            // before notes start scrolling.
            _showFollowerSongToast(highway.getSongInfo());
        } catch (e) {
            console.error('[splitscreen-follower] song-change rebuild failed:', e);
        } finally {
            _followerRebuildBusy = false;
            const pending = _followerPendingFilename;
            _followerPendingFilename = null;
            if (!_followerOrphaned && pending && pending !== currentFilename) {
                _handleFollowerSongChange(pending);
            }
        }
    }

    // ── Song-change toast (popup only) ────────────────────────────────
    // An overlay shown right after _handleFollowerSongChange finishes
    // rebuilding the panels. Stays visible until the main window starts
    // playback (detected by time-broadcasts advancing past the baseline
    // captured at toast-creation). Replaces any prior toast in flight
    // so a rapid sequence of song changes doesn't pile up.
    const FOLLOWER_TOAST_FADE_MS = 400;
    // Time threshold (seconds) the broadcast `t` must exceed beyond the
    // baseline captured when the toast was shown, before we treat the
    // song as "started." 50ms covers floating-point slop and the 60Hz
    // broadcast interval (~17ms) without flapping.
    const FOLLOWER_TOAST_PLAY_THRESHOLD_S = 0.05;
    let _followerToast = null;
    let _followerToastBaselineTime = 0;

    // Common-tuning name resolver. Order-agnostic — works whether the
    // tuning array is high-to-low or low-to-high (we test both ends for
    // the drop pattern). Returns null for anything that isn't a flat
    // uniform offset or a one-string drop variant; the caller falls
    // back to displaying raw offsets in that case.
    function _resolveFollowerTuningName(tuning) {
        if (!Array.isArray(tuning) || tuning.length === 0) return null;
        const STANDARD_NAMES = {
            '0':  'E Standard',
            '-1': 'Eb Standard',
            '-2': 'D Standard',
            '-3': 'C# Standard',
            '-4': 'C Standard',
            '2':  'F# Standard',
        };
        const DROP_NAMES = {
            '0':  'Drop D',
            '-1': 'Drop Db',
            '-2': 'Drop C',
            '-3': 'Drop B',
            '-4': 'Drop Bb',
        };
        const allEqual = tuning.every(t => t === tuning[0]);
        if (allEqual) return STANDARD_NAMES[String(tuning[0])] || null;
        // One-string drop: low string is 2 semitones below an otherwise-
        // uniform offset. Test both possible orientations of the array.
        const last = tuning.length - 1;
        const headEqual = tuning.slice(0, last).every(t => t === tuning[0]);
        if (headEqual && tuning[last] === tuning[0] - 2) {
            return DROP_NAMES[String(tuning[0])] || null;
        }
        const tail = tuning.slice(1);
        const tailEqual = tail.every(t => t === tail[0]);
        if (tailEqual && tuning[0] === tail[0] - 2) {
            return DROP_NAMES[String(tail[0])] || null;
        }
        return null;
    }

    function _dismissFollowerToast() {
        if (!_followerToast) return;
        const toast = _followerToast;
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-12px)';
        setTimeout(() => {
            if (_followerToast === toast) _followerToast = null;
            toast.remove();
        }, FOLLOWER_TOAST_FADE_MS);
    }

    // Called from the time-broadcast handler. Dismisses the toast the
    // first time the main window's audio.currentTime advances past the
    // baseline captured at toast-creation — i.e. play has actually
    // started. While main is paused at the new song's start (t = 0),
    // every broadcast carries the same t and the toast stays visible.
    function _maybeDismissFollowerToastOnPlay(t) {
        if (!_followerToast) return;
        if (t > _followerToastBaselineTime + FOLLOWER_TOAST_PLAY_THRESHOLD_S) {
            _dismissFollowerToast();
        }
    }

    function _showFollowerSongToast(info) {
        if (!info) return;
        // Replace any existing toast (rapid song-change sequence).
        if (_followerToast) { _followerToast.remove(); _followerToast = null; }

        const toast = document.createElement('div');
        toast.id = 'follower-song-toast';
        toast.style.cssText =
            'position:fixed;top:24px;left:50%;' +
            'transform:translateX(-50%) translateY(-12px);' +
            'min-width:280px;max-width:80vw;padding:14px 22px;' +
            'background:rgba(8,8,16,0.95);border:1px solid #4080e0;border-radius:8px;' +
            'box-shadow:0 6px 20px rgba(0,0,0,0.55);' +
            'z-index:10002;font-family:sans-serif;color:#e5e7eb;text-align:center;' +
            'opacity:0;transition:opacity ' + FOLLOWER_TOAST_FADE_MS + 'ms ease,' +
            'transform ' + FOLLOWER_TOAST_FADE_MS + 'ms ease;' +
            'pointer-events:none;';

        const title = document.createElement('div');
        title.style.cssText = 'font-size:18px;font-weight:600;color:#fff;line-height:1.25;';
        title.textContent = info.title || 'Untitled';
        toast.appendChild(title);

        if (info.artist) {
            const artist = document.createElement('div');
            artist.style.cssText = 'font-size:13px;color:#9ca3af;margin-top:2px;';
            artist.textContent = info.artist;
            toast.appendChild(artist);
        }

        const detailLines = [];
        const tuningName = _resolveFollowerTuningName(info.tuning);
        if (tuningName) detailLines.push('Tuning: ' + tuningName);
        else if (Array.isArray(info.tuning) && info.tuning.length > 0) {
            detailLines.push('Tuning: [' + info.tuning.join(', ') + ']');
        }
        if (Number.isFinite(info.capo) && info.capo > 0) detailLines.push('Capo: ' + info.capo);

        if (detailLines.length > 0) {
            const details = document.createElement('div');
            details.style.cssText = 'font-size:12px;color:#9ca3af;margin-top:8px;line-height:1.5;';
            details.textContent = detailLines.join(' · ');
            toast.appendChild(details);
        }

        // Per-panel arrangement breakdown — only shown when there are 2+
        // panels in the popup, since a single panel is self-evident
        // from the highway already visible behind the toast.
        if (panels.length > 1) {
            const panelInfo = document.createElement('div');
            panelInfo.style.cssText = 'font-size:11px;color:#9ca3af;margin-top:6px;line-height:1.4;';
            const panelLabels = panels.map((p, idx) => {
                const arrName = arrangements[p.arrIndex]?.name || 'Arr ' + p.arrIndex;
                const modeSuffix = p.lyricsMode ? ' (Lyrics)'
                    : p.jumpingTabMode ? ' (JT)'
                    : p.vizMode ? ' (' + (vizPlugins.find(vp => vp.id === p.vizMode)?.name || p.vizMode) + ')'
                    : '';
                return 'P' + (idx + 1) + ': ' + arrName + modeSuffix;
            });
            panelInfo.textContent = panelLabels.join(' · ');
            toast.appendChild(panelInfo);
        }

        document.body.appendChild(toast);
        _followerToast = toast;
        // Snapshot the current broadcast time so we can detect playback
        // starting later. While main is paused, time messages keep
        // arriving with this same value and the toast stays visible.
        _followerToastBaselineTime = _followerCurrentTime;

        // Animate in next frame so the initial opacity:0 / translateY
        // styles take effect before the transition kicks in.
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
            toast.style.transform = 'translateX(-50%) translateY(0)';
        });
    }

    // Kick off follower-mode bootstrap — placed at the very end of the IIFE
    // so all `let` bindings the function touches (e.g. _followerAudio) are
    // past their temporal dead zone by the time the function executes.
    if (FOLLOWER) bootFollowerMode();
})();
