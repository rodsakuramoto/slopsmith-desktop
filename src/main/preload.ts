// Preload script — exposes safe APIs to the Slopsmith webview.
// The existing Slopsmith frontend runs unchanged; this adds
// window.slopsmithDesktop for audio engine and desktop features.

const { contextBridge, ipcRenderer } = require('electron');
import type { IpcRendererEvent } from 'electron';
import type { StartupStatus } from './python';
import {
    IPC_STARTUP_STATUS,
    IPC_STARTUP_GET_STATUS,
    IPC_STARTUP_REQUEST_STATUS,
    IPC_BACKING_STREAM_PORT,
    IPC_BACKING_STREAM_ROUTING,
} from './ipc-channels';

// Internal audio routing (Windows-only): the main process sends a transferable
// MessagePort whenever the backing-track capture script needs one (typically
// once per page load). Preload scripts can't put the port on a contextBridge
// surface — they have to forward it via window.postMessage so the main world
// can grab it from the event's transferable list. The capture script in
// audio-capture.ts listens for this message and starts streaming PCM.
ipcRenderer.on(IPC_BACKING_STREAM_PORT, (event: IpcRendererEvent) => {
    const port = event.ports[0];
    if (!port) return;
    window.postMessage({ slopsmithBackingStreamPort: true }, '*', [port]);
});

// Forward routing-mode changes (exclusive on/off) into the page world too,
// so the capture script can connect/disconnect from audioCtx.destination.
ipcRenderer.on(IPC_BACKING_STREAM_ROUTING, (_event: IpcRendererEvent, payload: { active: boolean }) => {
    window.postMessage({ slopsmithBackingStreamRouting: !!payload?.active }, '*');
});

// Audio sync offset — set as a mutable property via the isolated world bridge.
// The settings panel reads/writes localStorage and updates this at runtime.

contextBridge.exposeInMainWorld('slopsmithDesktop', {
    // Platform detection
    isDesktop: true,
    platform: process.platform,

    // Audio engine
    audio: {
        isAvailable: () => ipcRenderer.invoke('audio:isAvailable'),

        // Device management
        getDeviceTypes: () => ipcRenderer.invoke('audio:getDeviceTypes'),
        getSampleRates: () => ipcRenderer.invoke('audio:getSampleRates'),
        getBufferSizes: () => ipcRenderer.invoke('audio:getBufferSizes'),
        getCurrentDevice: () => ipcRenderer.invoke('audio:getCurrentDevice'),
        setDeviceType: (typeName: string) => ipcRenderer.invoke('audio:setDeviceType', typeName),
        setDevice: (input: string, output: string, sampleRate: number, bufferSize: number) =>
            ipcRenderer.invoke('audio:setDevice', input, output, sampleRate, bufferSize),

        // Audio control
        startAudio: () => ipcRenderer.invoke('audio:startAudio'),
        stopAudio: () => ipcRenderer.invoke('audio:stopAudio'),
        isAudioRunning: () => ipcRenderer.invoke('audio:isAudioRunning'),

        // Gain
        setGain: (which: string, value: number) => ipcRenderer.invoke('audio:setGain', which, value),
        setInputChannel: (channel: number) => ipcRenderer.invoke('audio:setInputChannel', channel),
        setMonitorMute: (mute: boolean) => ipcRenderer.invoke('audio:setMonitorMute', mute),
        isMonitorMuted: () => ipcRenderer.invoke('audio:isMonitorMuted'),

        // Metering (polled at 60fps from renderer)
        getLevels: () => ipcRenderer.invoke('audio:getLevels'),
        resetPeaks: () => ipcRenderer.invoke('audio:resetPeaks'),

        // Pitch detection (polled)
        getPitchDetection: () => ipcRenderer.invoke('audio:getPitchDetection'),

        // VST plugins
        scanPlugins: (dirs?: string[]) => ipcRenderer.invoke('audio:scanPlugins', dirs),
        getKnownPlugins: () => ipcRenderer.invoke('audio:getKnownPlugins'),
        savePluginList: (path?: string) => ipcRenderer.invoke('audio:savePluginList', path),
        loadPluginList: (path?: string) => ipcRenderer.invoke('audio:loadPluginList', path),

        // Signal chain
        loadVST: (pluginPath: string) => ipcRenderer.invoke('audio:loadVST', pluginPath),
        loadNAMModel: (modelPath: string) => ipcRenderer.invoke('audio:loadNAMModel', modelPath),
        loadIR: (irPath: string) => ipcRenderer.invoke('audio:loadIR', irPath),
        removeProcessor: (slotId: number) => ipcRenderer.invoke('audio:removeProcessor', slotId),
        moveProcessor: (from: number, to: number) => ipcRenderer.invoke('audio:moveProcessor', from, to),
        setBypass: (slotId: number, bypassed: boolean) => ipcRenderer.invoke('audio:setBypass', slotId, bypassed),
        clearChain: () => ipcRenderer.invoke('audio:clearChain'),
        getChainState: () => ipcRenderer.invoke('audio:getChainState'),

        // Plugin editor
        openPluginEditor: (slotId: number) => ipcRenderer.invoke('audio:openPluginEditor', slotId),
        closePluginEditor: (slotId: number) => ipcRenderer.invoke('audio:closePluginEditor', slotId),

        // Parameters
        getParameters: (slotId: number) => ipcRenderer.invoke('audio:getParameters', slotId),
        setParameter: (slotId: number, paramIndex: number, value: number) =>
            ipcRenderer.invoke('audio:setParameter', slotId, paramIndex, value),

        // MIDI
        sendMidiToSlot: (slotId: number, msgType: number, channel: number, param1: number, param2?: number) =>
            ipcRenderer.invoke('audio:sendMidiToSlot', slotId, msgType, channel, param1, param2),

        // Backing track
        loadBackingTrack: (filePath: string) => ipcRenderer.invoke('audio:loadBackingTrack', filePath),
        startBacking: () => ipcRenderer.invoke('audio:startBacking'),
        stopBacking: () => ipcRenderer.invoke('audio:stopBacking'),
        seekBacking: (seconds: number) => ipcRenderer.invoke('audio:seekBacking', seconds),

        // Presets
        savePreset: () => ipcRenderer.invoke('audio:savePreset'),
        loadPreset: (presetJson: string) => ipcRenderer.invoke('audio:loadPreset', presetJson),

        // Tone switching
        setMultiBypass: (changes: Array<{slotId: number, bypassed: boolean}>) =>
            ipcRenderer.invoke('audio:setMultiBypass', changes),

        // Internal audio routing (Windows-only fix for exclusive-mode lockout).
        // The renderer captures <audio id="audio"> via Web Audio and streams
        // PCM to the C++ engine; these methods control / observe that path.
        backingStream: {
            setEnabled: (enabled: boolean) =>
                ipcRenderer.invoke('audio:setBackingStreamEnabled', enabled),
            isEnabled: () => ipcRenderer.invoke('audio:isBackingStreamEnabled'),
            reset: () => ipcRenderer.invoke('audio:resetBackingStream'),
            getStats: () => ipcRenderer.invoke('audio:getBackingStreamStats'),
            isCurrentDeviceExclusive: () =>
                ipcRenderer.invoke('audio:isCurrentDeviceExclusive'),
        },
    },

    // Plugin management
    plugins: {
        install: (gitUrl: string, name?: string) => ipcRenderer.invoke('plugins:install', gitUrl, name),
        remove: (name: string) => ipcRenderer.invoke('plugins:remove', name),
        update: (name: string) => ipcRenderer.invoke('plugins:update', name),
        listInstalled: () => ipcRenderer.invoke('plugins:listInstalled'),
    },

    // Soundfont (Audio Quality preference for GP5 → audio rendering)
    soundfont: {
        getStatus: () => ipcRenderer.invoke('soundfont:getStatus'),
        downloadHighQuality: () => ipcRenderer.invoke('soundfont:downloadHighQuality'),
        cancelDownload: () => ipcRenderer.invoke('soundfont:cancelDownload'),
        setQuality: (quality: 'default' | 'high') => ipcRenderer.invoke('soundfont:setQuality', quality),
        onDownloadProgress: (
            callback: (progress: { bytesDownloaded: number; totalBytes: number; percent: number }) => void,
        ) => {
            const listener = (_event: unknown, progress: { bytesDownloaded: number; totalBytes: number; percent: number }) => callback(progress);
            ipcRenderer.on('soundfont:downloadProgress', listener);
            return () => ipcRenderer.removeListener('soundfont:downloadProgress', listener);
        },
    },

    // File dialogs
    pickFile: (filters?: { name: string; extensions: string[] }[]) =>
        ipcRenderer.invoke('dialog:pickFile', filters),
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
    pickFiles: (filters?: { name: string; extensions: string[] }[]) =>
        ipcRenderer.invoke('dialog:pickFiles', filters),

    // App info
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
    getConfigDir: () => ipcRenderer.invoke('app:getConfigDir'),

    // Startup status
    startup: {
        getStatus: () => ipcRenderer.invoke(IPC_STARTUP_GET_STATUS),
        onStatus: (callback: (status: StartupStatus) => void) => {
            const listener = (_event: unknown, status: StartupStatus) => callback(status);
            ipcRenderer.on(IPC_STARTUP_STATUS, listener);
            ipcRenderer.send(IPC_STARTUP_REQUEST_STATUS);
            return () => ipcRenderer.removeListener(IPC_STARTUP_STATUS, listener);
        },
    },
});

export {};
