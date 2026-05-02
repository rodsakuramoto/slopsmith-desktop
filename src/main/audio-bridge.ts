// Audio Bridge — connects the JUCE native addon to Electron IPC.
// The native addon is loaded via require() and its methods are
// exposed to the renderer process via ipcMain.handle().

import { ipcMain, BrowserWindow, MessageChannelMain, MessagePortMain } from 'electron';
import * as path from 'path';
import { app } from 'electron';
import { IPC_BACKING_STREAM_PORT, IPC_BACKING_STREAM_ROUTING } from './ipc-channels';

type AudioModule = Record<string, (...args: any[]) => any>;

let audio: AudioModule | null = null;
let backingStreamPort: MessagePortMain | null = null;
let lastRoutingActive = false;

function loadNativeAddon(): AudioModule | null {
    const addonPaths = [
        // Development build
        path.join(__dirname, '..', '..', 'build', 'Release', 'slopsmith_audio.node'),
        // Packaged build (unpacked from asar, the default for electron-builder asarUnpack entries)
        path.join(process.resourcesPath || '', 'app.asar.unpacked', 'build', 'Release', 'slopsmith_audio.node'),
        // Alternative location (direct copy to resources)
        path.join(process.resourcesPath || '', 'build', 'Release', 'slopsmith_audio.node'),
    ];

    for (const addonPath of addonPaths) {
        try {
            const mod = require(addonPath);
            console.log(`[audio] Loaded native addon from ${addonPath}`);
            return mod;
        } catch (e: any) {
            console.log(`[audio] Could not load from ${addonPath}: ${e.message}`);
        }
    }

    console.warn('[audio] Native audio addon not found — audio features disabled');
    console.warn('[audio] Build it with: npm run build:audio');
    return null;
}

export function initAudioBridge(mainWindow: BrowserWindow | null): void {
    audio = loadNativeAddon();

    if (audio) {
        try {
            audio.init();
            console.log('[audio] Engine initialized');
        } catch (e: any) {
            console.error(`[audio] Init failed: ${e.message}`);
            audio = null;
        }
    }

    // Preset/plugin list paths
    const configDir = app.getPath('userData');

    // ── Lifecycle ──────────────────────────────────────────────────────────

    ipcMain.handle('audio:isAvailable', () => audio !== null);

    // ── Device Management ──────────────────────────────────────────────────

    ipcMain.handle('audio:getDeviceTypes', () => {
        const result = audio?.getDeviceTypes() ?? [];
        return result.map((t: any) => ({
            name: String(t.name || ''),
            inputs: Array.isArray(t.inputs) ? t.inputs.map(String) : [],
            outputs: Array.isArray(t.outputs) ? t.outputs.map(String) : [],
        }));
    });

    ipcMain.handle('audio:getSampleRates', () => {
        return audio?.getSampleRates() ?? [];
    });

    ipcMain.handle('audio:getBufferSizes', () => {
        return audio?.getBufferSizes() ?? [];
    });

    ipcMain.handle('audio:getCurrentDevice', () => {
        return audio?.getCurrentDevice() ?? null;
    });

    ipcMain.handle('audio:setDeviceType', (_event, typeName: string) => {
        const result = audio?.setDeviceType(typeName) ?? false;
        if (result) reevaluateInternalRouting(mainWindow);
        return result;
    });

    ipcMain.handle('audio:setDevice', (_event, input: string, output: string, sampleRate: number, bufferSize: number) => {
        const result = audio?.setDevice(input, output, sampleRate, bufferSize) ?? false;
        if (result) reevaluateInternalRouting(mainWindow);
        return result;
    });

    // ── Audio Control ──────────────────────────────────────────────────────

    ipcMain.handle('audio:startAudio', () => {
        audio?.startAudio();
    });

    ipcMain.handle('audio:stopAudio', () => {
        audio?.stopAudio();
    });

    ipcMain.handle('audio:isAudioRunning', () => {
        return audio?.isAudioRunning() ?? false;
    });

    // ── Gain ───────────────────────────────────────────────────────────────

    ipcMain.handle('audio:setGain', (_event, which: string, value: number) => {
        audio?.setGain(which, value);
    });

    ipcMain.handle('audio:setInputChannel', (_event, channel: number) => {
        audio?.setInputChannel(channel);
    });

    ipcMain.handle('audio:setMonitorMute', (_event, mute: boolean) => {
        audio?.setMonitorMute(mute);
    });

    ipcMain.handle('audio:isMonitorMuted', () => {
        return audio?.isMonitorMuted() ?? true;
    });

    // ── Metering ───────────────────────────────────────────────────────────

    ipcMain.handle('audio:getLevels', () => {
        return audio?.getLevels() ?? { inputLevel: 0, outputLevel: 0, inputPeak: 0, outputPeak: 0 };
    });

    ipcMain.handle('audio:resetPeaks', () => {
        audio?.resetPeaks();
    });

    // ── Pitch Detection ────────────────────────────────────────────────────

    ipcMain.handle('audio:getPitchDetection', () => {
        return audio?.getPitchDetection() ?? { frequency: -1, confidence: 0, midiNote: -1, cents: 0, noteName: '' };
    });

    // ── VST Scanning ───────────────────────────────────────────────────────

    ipcMain.handle('audio:scanPlugins', async (_event, dirs?: string[]) => {
        if (!audio) return [];
        return await audio.scanPlugins(dirs);
    });

    ipcMain.handle('audio:getKnownPlugins', () => {
        return audio?.getKnownPlugins() ?? [];
    });

    ipcMain.handle('audio:savePluginList', (_event, filePath: string) => {
        audio?.savePluginList(filePath || path.join(configDir, 'known-plugins.xml'));
    });

    ipcMain.handle('audio:loadPluginList', (_event, filePath: string) => {
        audio?.loadPluginList(filePath || path.join(configDir, 'known-plugins.xml'));
    });

    // ── Signal Chain ───────────────────────────────────────────────────────

    ipcMain.handle('audio:loadVST', (_event, pluginPath: string) => {
        return audio?.loadVST(pluginPath) ?? -1;
    });

    ipcMain.handle('audio:loadNAMModel', async (_event, modelPath: string) => {
        return await audio?.loadNAMModel(modelPath) ?? -1;
    });

    ipcMain.handle('audio:loadIR', async (_event, irPath: string) => {
        return await audio?.loadIR(irPath) ?? -1;
    });

    ipcMain.handle('audio:removeProcessor', (_event, slotId: number) => {
        audio?.removeProcessor(slotId);
    });

    ipcMain.handle('audio:moveProcessor', (_event, from: number, to: number) => {
        audio?.moveProcessor(from, to);
    });

    ipcMain.handle('audio:setBypass', (_event, slotId: number, bypassed: boolean) => {
        audio?.setBypass(slotId, bypassed);
    });

    ipcMain.handle('audio:clearChain', () => {
        audio?.clearChain();
    });

    ipcMain.handle('audio:getChainState', () => {
        return audio?.getChainState() ?? [];
    });

    // ── Plugin Editor ──────────────────────────────────────────────────────

    ipcMain.handle('audio:openPluginEditor', (_event, slotId: number) => {
        return audio?.openPluginEditor(slotId) ?? false;
    });

    ipcMain.handle('audio:closePluginEditor', (_event, slotId: number) => {
        return audio?.closePluginEditor(slotId) ?? false;
    });

    // ── Parameters ─────────────────────────────────────────────────────────

    ipcMain.handle('audio:getParameters', (_event, slotId: number) => {
        return audio?.getParameters(slotId) ?? [];
    });

    ipcMain.handle('audio:setParameter', (_event, slotId: number, paramIndex: number, value: number) => {
        audio?.setParameter(slotId, paramIndex, value);
    });

    // ── MIDI ───────────────────────────────────────────────────────────────

    ipcMain.handle('audio:sendMidiToSlot', (_event, slotId: number, msgType: number, channel: number, param1: number, param2?: number) => {
        return audio?.sendMidiToSlot(slotId, msgType, channel, param1, param2 ?? 0) ?? false;
    });

    // ── Backing Track ──────────────────────────────────────────────────────

    ipcMain.handle('audio:loadBackingTrack', (_event, filePath: string) => {
        return audio?.loadBackingTrack(filePath) ?? false;
    });

    ipcMain.handle('audio:startBacking', () => audio?.startBacking());
    ipcMain.handle('audio:stopBacking', () => audio?.stopBacking());
    ipcMain.handle('audio:seekBacking', (_event, seconds: number) => audio?.seekBacking(seconds));

    // ── Presets ────────────────────────────────────────────────────────────

    ipcMain.handle('audio:savePreset', () => {
        return audio?.savePreset() ?? null;
    });

    ipcMain.handle('audio:loadPreset', async (_event, presetJson: string) => {
        return await audio?.loadPreset(presetJson) ?? { success: false, error: 'No audio' };
    });

    ipcMain.handle('audio:setMultiBypass', (_event, changes: Array<{slotId: number, bypassed: boolean}>) => {
        return audio?.setMultiBypass(changes) ?? false;
    });

    // ── Internal Audio Routing (Windows exclusive-mode fix) ────────────────
    //
    // Renderer-side capture (AudioWorklet on the slopsmith <audio> element)
    // streams interleaved Float32 PCM here over a MessagePort, where we hand
    // it directly to the native addon's lock-free ring buffer. The C++ audio
    // callback then mixes it alongside the processed guitar signal into the
    // single exclusive output stream. Non-Windows callers can still flip the
    // routing flag, but the C++ mixdown branch only compiles in on _WIN32 so
    // this is effectively a no-op there.
    //
    // The MessagePort handshake itself is initiated from main.ts after the
    // page finishes loading (so a MessageChannelMain is wired up to the
    // renderer's main-world capture script via the preload bridge).

    ipcMain.handle('audio:setBackingStreamEnabled', (_event, enabled: boolean) => {
        if (audio) audio.setBackingStreamEnabled(!!enabled);
        notifyRoutingChanged(mainWindow, !!enabled);
    });

    ipcMain.handle('audio:isBackingStreamEnabled', () => {
        return audio?.isBackingStreamEnabled() ?? false;
    });

    ipcMain.handle('audio:resetBackingStream', () => {
        audio?.resetBackingStream();
    });

    ipcMain.handle('audio:getBackingStreamStats', () => {
        return audio?.getBackingStreamStats() ?? {
            enabled: false, underruns: 0, fillFraction: 0, exclusive: false,
        };
    });

    ipcMain.handle('audio:isCurrentDeviceExclusive', () => {
        return audio?.isCurrentDeviceExclusive() ?? false;
    });
}

// ── MessagePort handshake (called from main.ts on did-finish-load) ──────────

export function attachBackingStreamPort(window: BrowserWindow): void {
    if (process.platform !== 'win32') {
        // Non-Windows builds skip the entire capture path. macOS / Linux fall
        // back to JUCE's existing behavior — backing audio plays through the
        // OS mixer, which on those platforms shares the device fine.
        return;
    }
    if (!audio) return;

    // Tear down any prior port (page reload, window recreate). The previous
    // port was scoped to the previous renderer; we always want a fresh pair.
    if (backingStreamPort) {
        try { backingStreamPort.close(); } catch { /* already gone */ }
        backingStreamPort = null;
    }

    const channel = new MessageChannelMain();
    backingStreamPort = channel.port1;

    backingStreamPort.on('message', (event) => {
        const msg = event.data;
        if (!msg || !audio) return;
        const { buf, ch, frames, sr } = msg as {
            buf: ArrayBuffer; ch: number; frames: number; sr: number;
        };
        if (!buf) return;
        // Float32 PCM is sent transferable so this is a zero-copy view.
        const floats = new Float32Array(buf);
        try {
            audio.pushBackingStream(floats, ch, frames, sr);
        } catch (e: any) {
            console.warn(`[audio] pushBackingStream threw: ${e?.message ?? e}`);
        }
    });
    backingStreamPort.start();

    window.webContents.postMessage(IPC_BACKING_STREAM_PORT, null, [channel.port2]);

    // Re-evaluate routing now that the renderer is ready to receive the
    // routing-changed event.
    reevaluateInternalRouting(window);
}

function reevaluateInternalRouting(window: BrowserWindow | null): void {
    if (process.platform !== 'win32' || !audio) return;
    const exclusive: boolean = !!audio.isCurrentDeviceExclusive();
    if (exclusive !== lastRoutingActive) {
        audio.setBackingStreamEnabled(exclusive);
    }
    notifyRoutingChanged(window, exclusive);
}

function notifyRoutingChanged(window: BrowserWindow | null, active: boolean): void {
    lastRoutingActive = active;
    if (window && !window.isDestroyed()) {
        window.webContents.send(IPC_BACKING_STREAM_ROUTING, { active });
    }
}

export function shutdownAudio(): void {
    if (backingStreamPort) {
        try { backingStreamPort.close(); } catch { /* already gone */ }
        backingStreamPort = null;
    }
    if (audio) {
        try {
            audio.shutdown();
            try { console.log('[audio] Engine shut down'); } catch { /* console may be gone */ }
        } catch { /* silent fail during shutdown */ }
    }
}
