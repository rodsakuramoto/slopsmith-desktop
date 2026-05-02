#pragma once
#include <juce_audio_basics/juce_audio_basics.h>
#include <atomic>

// Lock-free SPSC ring buffer that receives interleaved Float32 PCM from the
// renderer (pushed via the N-API hot path) and feeds resampled stereo audio
// into the real-time audio callback.
//
// Threading model:
//   - pushInterleaved()        → called from the Node.js / N-API thread.
//   - pullAndAddTo() / reset() → called from the audio device callback thread.
//   - Stats getters            → safe from any thread (atomics).
//
// Sample-rate conversion happens here, on the audio thread, using JUCE's
// WindowedSinc interpolator (one instance per channel). This keeps the
// renderer-side worklet simple — it only needs to ship raw frames at the
// AudioContext's native rate.
//
// This object is only meaningfully exercised on Windows (ASIO / WASAPI
// Exclusive). On macOS / Linux it is constructed but never enabled, and
// its push/pull methods short-circuit cheaply.
class StreamedBackingBuffer
{
public:
    StreamedBackingBuffer();
    ~StreamedBackingBuffer() = default;

    // Called from the audio thread when the device starts / its block size
    // or sample rate changes.
    void prepare(double dstSampleRate, int maxBlockSize);

    // Drop everything currently buffered and reset interpolator state.
    // Safe to call from the audio thread (called inside prepare()) or from
    // the N-API thread when the renderer reports a routing change.
    void reset();

    // Push interleaved PCM from the renderer. Channels are downmixed/expanded
    // to stereo internally; mono input is duplicated to L/R, anything > 2
    // channels keeps only the first two. Returns the number of source frames
    // actually accepted (may be less than numFrames if the ring is full —
    // overflow drops the oldest samples to keep latency bounded).
    //
    // srcSampleRate is latched from the first push and updated whenever the
    // renderer reports a different rate (e.g. AudioContext rate changed).
    int pushInterleaved(const float* interleaved,
                        int numChannels,
                        int numFrames,
                        double srcSampleRate);

    // Pull numSamples of resampled audio and add it (with gain) into dst.
    // dst must have at least 1 channel; channels beyond 2 receive a copy of
    // the right channel.
    //
    // If the ring underruns this call adds nothing (silent contribution) and
    // increments the underrun counter. The caller must clear dst before
    // calling if they want guaranteed silence on starvation.
    void pullAndAddTo(juce::AudioBuffer<float>& dst,
                      int startSample,
                      int numSamples,
                      float gain);

    // Diagnostics — safe from any thread.
    int   getUnderrunCount() const noexcept { return underruns.load(); }
    float getFillFraction()  const noexcept;
    bool  isPrimed()         const noexcept { return primed.load(); }
    int   getCapacityFrames() const noexcept { return ringCapacity; }

private:
    // Stereo, deinterleaved ring at the source sample rate. Sized large
    // enough (~700 ms @ 48 kHz) to absorb scheduling jitter between Node's
    // event loop and the audio thread without underruns.
    static constexpr int kRingCapacity = 1 << 15; // 32768 frames

    juce::AbstractFifo fifo { kRingCapacity };
    juce::AudioBuffer<float> ring;
    int ringCapacity = kRingCapacity;

    // Resamplers — one per output channel, stateful across pull calls.
    juce::Interpolators::WindowedSinc interpL;
    juce::Interpolators::WindowedSinc interpR;

    // Scratch buffer for copying ring → contiguous block before resampling.
    // Resized in prepare() to fit the worst-case source-frame count for one
    // audio block, so pullAndAddTo never allocates on the audio thread.
    juce::AudioBuffer<float> scratch;

    std::atomic<double> srcSampleRate { 48000.0 };
    double dstSampleRate = 48000.0;
    int    maxDstBlock   = 1024;

    // Soft-start gate: hold output silent until the ring has accumulated at
    // least `primeThreshold` source frames. Prevents a guaranteed underrun
    // on the first audio callback after enabling streamed routing, before
    // the worklet has had a chance to deliver its first message.
    std::atomic<bool> primed { false };
    int primeThreshold = 0;

    std::atomic<int> underruns { 0 };

    // Recompute scratch size, prime threshold, etc. when sample rates change.
    void updateDerivedSizes();
};
