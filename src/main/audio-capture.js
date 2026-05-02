// Slopsmith backing-track capture (Windows internal-routing fix).
//
// Injected into the slopsmith webapp's main world by main.ts on every
// did-finish-load (Windows only). Taps the existing `<audio id="audio">`
// element via Web Audio + AudioWorklet and streams interleaved Float32 PCM
// over a MessagePort to the C++ engine, where the audio thread mixes it
// alongside the processed guitar signal in a single exclusive output
// stream.
//
// Two routing modes:
//   - "engine"  → audio is *not* connected to audioCtx.destination; only
//                 the C++ engine outputs it. Used when the active device is
//                 ASIO or WASAPI Exclusive (the OS mixer is locked out).
//   - "os"      → audio is connected to audioCtx.destination as well, so
//                 the OS mixer can play it. Used in shared mode; the engine
//                 will simply ignore the streamed PCM (its mixdown branch is
//                 gated on a flag set by the main process).
//
// The script is idempotent: main.ts wraps it in an installation guard so
// reloads don't pile up extra worklets.

(() => {
    'use strict';

    const TAG = '[slopsmith-backing-capture]';

    // ── AudioWorklet processor source (loaded as a Blob URL) ────────────────
    //
    // Posts each render quantum (typically 128 frames) back to the main
    // thread, interleaving channels and transferring the underlying
    // ArrayBuffer for zero-copy. The processor is intentionally minimal —
    // sample-rate conversion is done in C++ to keep the renderer cheap.
    const WORKLET_SOURCE = `
        class BackingStreamProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this._enabled = true;
                this.port.onmessage = (e) => {
                    if (e && e.data && typeof e.data.enabled === 'boolean') {
                        this._enabled = e.data.enabled;
                    }
                };
            }
            process(inputs) {
                if (!this._enabled) return true;
                const input = inputs[0];
                if (!input || input.length === 0) return true;
                const numCh = input.length;
                const numFrames = input[0] ? input[0].length : 0;
                if (numFrames === 0) return true;
                const out = new Float32Array(numCh * numFrames);
                if (numCh === 1) {
                    out.set(input[0]);
                } else {
                    for (let ch = 0; ch < numCh; ch++) {
                        const src = input[ch];
                        for (let i = 0; i < numFrames; i++) {
                            out[i * numCh + ch] = src[i];
                        }
                    }
                }
                this.port.postMessage(
                    { buf: out.buffer, ch: numCh, frames: numFrames, sr: sampleRate },
                    [out.buffer]
                );
                return true;
            }
        }
        registerProcessor('slopsmith-backing-stream', BackingStreamProcessor);
    `;

    let audioCtx = null;
    let sourceNode = null;
    let workletNode = null;
    let destinationConnected = false;
    let streamPort = null;
    // Default to "OS" routing until the engine tells us otherwise — keeps
    // shared-mode users hearing audio even before the first IPC message.
    let routingMode = 'os';
    let attachedEl = null;

    function log(msg, ...rest) {
        try { console.log(TAG, msg, ...rest); } catch (_) { /* console may be gone */ }
    }

    function warn(msg, ...rest) {
        try { console.warn(TAG, msg, ...rest); } catch (_) { /* console may be gone */ }
    }

    // ── Element discovery ──────────────────────────────────────────────────
    //
    // The slopsmith page creates `<audio id="audio">` near the top of
    // index.html, but if we run before DOMContentLoaded it may not exist
    // yet. Watch for it and re-run setup when it appears.

    function findAudioElement() {
        return document.getElementById('audio');
    }

    function waitForAudioElement(cb) {
        const existing = findAudioElement();
        if (existing) { cb(existing); return; }
        const observer = new MutationObserver(() => {
            const el = findAudioElement();
            if (el) {
                observer.disconnect();
                cb(el);
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        // Backstop in case the element is added in a way the observer misses
        // (e.g. inside a closed shadow root). Polls every 250ms for up to 10s.
        let polls = 0;
        const poll = setInterval(() => {
            polls += 1;
            const el = findAudioElement();
            if (el) {
                clearInterval(poll);
                observer.disconnect();
                cb(el);
            } else if (polls > 40) {
                clearInterval(poll);
                warn('audio element not found after 10s — backing capture inactive');
            }
        }, 250);
    }

    // ── Routing control ────────────────────────────────────────────────────

    function applyRouting(mode) {
        if (!workletNode || !audioCtx) return;
        if (mode !== 'engine' && mode !== 'os') return;
        routingMode = mode;
        if (mode === 'engine') {
            if (destinationConnected) {
                try { workletNode.disconnect(audioCtx.destination); } catch (_) {}
                destinationConnected = false;
                log('routing → engine (OS mixer disconnected)');
            }
        } else {
            if (!destinationConnected) {
                try {
                    workletNode.connect(audioCtx.destination);
                    destinationConnected = true;
                    log('routing → os (OS mixer connected)');
                } catch (e) {
                    warn('failed to reconnect destination:', e);
                }
            }
        }
    }

    // ── Setup ─────────────────────────────────────────────────────────────

    async function attach(el) {
        if (attachedEl === el && audioCtx) return; // already wired up
        attachedEl = el;

        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            warn('failed to create AudioContext:', e);
            return;
        }

        // Resume the context on the first user gesture — Chromium blocks
        // autoplay until then. The slopsmith play button is the obvious
        // trigger; we also wire mousedown / keydown as a backstop.
        const resume = () => {
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume().catch(() => {});
            }
        };
        ['click', 'mousedown', 'keydown', 'touchstart'].forEach((ev) => {
            window.addEventListener(ev, resume, { once: false, passive: true });
        });

        const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
            await audioCtx.audioWorklet.addModule(blobUrl);
        } catch (e) {
            warn('audioWorklet.addModule failed:', e);
            URL.revokeObjectURL(blobUrl);
            return;
        }
        URL.revokeObjectURL(blobUrl);

        try {
            sourceNode = audioCtx.createMediaElementSource(el);
        } catch (e) {
            // createMediaElementSource throws if the element was already
            // wrapped in a previous AudioContext (e.g. partial reinstall).
            warn('createMediaElementSource failed:', e);
            return;
        }

        try {
            workletNode = new AudioWorkletNode(audioCtx, 'slopsmith-backing-stream');
        } catch (e) {
            warn('AudioWorkletNode construction failed:', e);
            return;
        }

        workletNode.port.onmessage = (e) => {
            if (!streamPort) return;
            const msg = e && e.data;
            if (!msg || !msg.buf) return;
            try {
                streamPort.postMessage(msg, [msg.buf]);
            } catch (err) {
                // Port may have been closed (page navigating away). Drop quietly.
            }
        };

        sourceNode.connect(workletNode);
        // Initial routing: OS by default. The engine will flip us to "engine"
        // mode via the IPC_BACKING_STREAM_ROUTING message once it observes an
        // exclusive-mode device.
        applyRouting('os');
        log('worklet graph attached, sampleRate =', audioCtx.sampleRate);
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────

    waitForAudioElement((el) => {
        attach(el).catch((e) => warn('attach failed:', e));
    });

    // MessagePort handoff from the main process (forwarded by preload). We
    // accept new ports at any time — page reloads / dev tools restarts will
    // produce fresh ones, and we want to swap cleanly without a click/pop.
    window.addEventListener('message', (ev) => {
        if (!ev || !ev.data) return;

        if (ev.data.slopsmithBackingStreamPort && ev.ports && ev.ports[0]) {
            if (streamPort) {
                try { streamPort.close(); } catch (_) {}
            }
            streamPort = ev.ports[0];
            try { streamPort.start(); } catch (_) {}
            log('MessagePort attached');
            return;
        }

        if (typeof ev.data.slopsmithBackingStreamRouting === 'boolean') {
            applyRouting(ev.data.slopsmithBackingStreamRouting ? 'engine' : 'os');
            return;
        }
    });
})();
