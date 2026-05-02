// Central registry of IPC channel names shared between the main process and
// preload scripts. Import this module in both sides so a rename never drifts.

export const IPC_STARTUP_STATUS = 'startup:status' as const;
export const IPC_STARTUP_GET_STATUS = 'startup:getStatus' as const;
export const IPC_STARTUP_REQUEST_STATUS = 'startup:requestStatus' as const;

// Internal audio routing (Windows-only fix for exclusive-mode lockout).
// The renderer's <audio id="audio"> backing track is captured via Web Audio
// and streamed to the C++ engine over a transferable MessagePort, so it can
// be mixed alongside the guitar inside a single ASIO/WASAPI-Exclusive output
// stream. See docs/internal-audio-routing.md (or the audio-bridge / preload
// hand-off code) for the full data flow.
export const IPC_BACKING_STREAM_PORT = 'audio:backingStreamPort' as const;
export const IPC_BACKING_STREAM_ROUTING = 'audio:backingStreamRouting' as const;
