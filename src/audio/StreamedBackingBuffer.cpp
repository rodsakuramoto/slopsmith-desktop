#include "StreamedBackingBuffer.h"
#include <algorithm>
#include <cmath>

StreamedBackingBuffer::StreamedBackingBuffer()
{
    ring.setSize(2, kRingCapacity, false, true, false);
    ring.clear();
    scratch.setSize(2, 4096, false, true, false);
    scratch.clear();
}

void StreamedBackingBuffer::prepare(double newDstSampleRate, int maxBlockSize)
{
    dstSampleRate = newDstSampleRate > 0.0 ? newDstSampleRate : 48000.0;
    maxDstBlock   = juce::jmax(64, maxBlockSize);
    updateDerivedSizes();
    reset();
}

void StreamedBackingBuffer::reset()
{
    fifo.reset();
    ring.clear();
    interpL.reset();
    interpR.reset();
    primed.store(false);
    underruns.store(0);
}

void StreamedBackingBuffer::updateDerivedSizes()
{
    const double src = srcSampleRate.load();
    const double ratio = src / dstSampleRate;

    // Worst-case source frames needed for one audio block, plus headroom for
    // the WindowedSinc filter's lookahead (it conservatively peeks ~32 taps
    // ahead). Round up generously; this is a one-time allocation.
    const int srcMax = (int) std::ceil(maxDstBlock * juce::jmax(1.0, ratio)) + 64;
    if (scratch.getNumSamples() < srcMax)
        scratch.setSize(2, srcMax, false, true, false);

    // Prime to ~3 audio blocks worth of source data before we start pulling,
    // so the very first pull can't starve.
    primeThreshold = juce::jmin(ringCapacity / 4, srcMax * 3);
}

int StreamedBackingBuffer::pushInterleaved(const float* interleaved,
                                           int numChannels,
                                           int numFrames,
                                           double newSrcSampleRate)
{
    if (interleaved == nullptr || numFrames <= 0 || numChannels <= 0)
        return 0;

    // Latch (and react to) sample-rate changes. Treat tiny drift as the same
    // rate so we don't churn scratch sizing every push.
    const double curSrc = srcSampleRate.load();
    if (newSrcSampleRate > 0.0 && std::abs(newSrcSampleRate - curSrc) > 0.5)
    {
        srcSampleRate.store(newSrcSampleRate);
        updateDerivedSizes();
    }

    // If the ring would overflow, drop oldest samples (advance the read head)
    // to keep latency bounded. Simpler than the alternative — backpressuring
    // the renderer would require synchronous IPC and could stall the page.
    const int free = fifo.getFreeSpace();
    if (numFrames > free)
    {
        const int toDrop = numFrames - free;
        int s1, n1, s2, n2;
        fifo.prepareToRead(toDrop, s1, n1, s2, n2);
        fifo.finishedRead(n1 + n2);
    }

    int s1, n1, s2, n2;
    fifo.prepareToWrite(numFrames, s1, n1, s2, n2);
    const int accepted = n1 + n2;

    auto* ringL = ring.getWritePointer(0);
    auto* ringR = ring.getWritePointer(1);

    auto deinterleaveTo = [&](int srcOffset, int destStart, int count)
    {
        for (int i = 0; i < count; ++i)
        {
            const int srcIdx = (srcOffset + i) * numChannels;
            const float l = interleaved[srcIdx];
            // Mono → duplicate; stereo+ → take the first two channels.
            const float r = (numChannels >= 2) ? interleaved[srcIdx + 1] : l;
            ringL[destStart + i] = l;
            ringR[destStart + i] = r;
        }
    };

    if (n1 > 0) deinterleaveTo(0,  s1, n1);
    if (n2 > 0) deinterleaveTo(n1, s2, n2);

    fifo.finishedWrite(accepted);

    if (! primed.load() && fifo.getNumReady() >= primeThreshold)
        primed.store(true);

    return accepted;
}

void StreamedBackingBuffer::pullAndAddTo(juce::AudioBuffer<float>& dst,
                                         int startSample,
                                         int numSamples,
                                         float gain)
{
    if (numSamples <= 0 || dst.getNumChannels() <= 0)
        return;

    if (! primed.load())
    {
        // Still soft-starting — nothing to add yet.
        return;
    }

    const double ratio = srcSampleRate.load() / dstSampleRate;
    const int srcNeeded = (int) std::ceil(numSamples * ratio) + 16;
    const int available = fifo.getNumReady();

    if (available < srcNeeded)
    {
        underruns.fetch_add(1);
        // Re-prime: wait until the renderer fills back up before pulling
        // again. Avoids a runaway cycle of one-off underruns each block.
        primed.store(false);
        return;
    }

    if (scratch.getNumSamples() < srcNeeded)
        scratch.setSize(2, srcNeeded, false, true, false);

    int s1, n1, s2, n2;
    fifo.prepareToRead(srcNeeded, s1, n1, s2, n2);

    auto copyOut = [&](int channel, float* destPtr)
    {
        const float* ringPtr = ring.getReadPointer(channel);
        if (n1 > 0) std::copy(ringPtr + s1, ringPtr + s1 + n1, destPtr);
        if (n2 > 0) std::copy(ringPtr + s2, ringPtr + s2 + n2, destPtr + n1);
    };

    auto* scratchL = scratch.getWritePointer(0);
    auto* scratchR = scratch.getWritePointer(1);
    copyOut(0, scratchL);
    copyOut(1, scratchR);

    // Resample + add into dst. Channels beyond R replicate the R channel so
    // surround configurations don't drop the backing track on the rears.
    const int numDstChans = dst.getNumChannels();
    auto* outL = dst.getWritePointer(0, startSample);
    auto* outR = (numDstChans >= 2) ? dst.getWritePointer(1, startSample) : nullptr;

    const int usedL = interpL.processAdding(ratio, scratchL, outL, numSamples, gain);
    int usedR = usedL;
    if (outR != nullptr)
        usedR = interpR.processAdding(ratio, scratchR, outR, numSamples, gain);

    for (int ch = 2; ch < numDstChans; ++ch)
    {
        auto* outX = dst.getWritePointer(ch, startSample);
        // Just add a copy of the right channel at unity (gain already baked
        // into outR by processAdding above — re-resample from scratch so the
        // interpolator state for ch>=2 stays aligned).
        juce::Interpolators::WindowedSinc tmp;
        tmp.processAdding(ratio, scratchR, outX, numSamples, gain);
    }

    // Both interpolators should consume the same number of source frames for
    // the same ratio; advance the FIFO by the larger value to be safe.
    const int used = juce::jmax(usedL, usedR);
    fifo.finishedRead(juce::jmin(used, srcNeeded));
}

float StreamedBackingBuffer::getFillFraction() const noexcept
{
    if (ringCapacity <= 0) return 0.0f;
    return (float) fifo.getNumReady() / (float) ringCapacity;
}
