import { describe, expect, it, vi } from 'vitest'
import {
  PcmAudioPlayer,
  StreamingTextChunker,
  VOICE_CHUNK_SOFT_LIMIT,
  pcm16ToFloat32,
} from '@/lib/ama-voice'

class MockAudioBuffer {
  readonly duration: number
  private readonly channelData: Float32Array

  constructor(length: number, sampleRate: number) {
    this.duration = length / sampleRate
    this.channelData = new Float32Array(length)
  }

  getChannelData() {
    return this.channelData
  }
}

class MockAudioBufferSourceNode {
  buffer: MockAudioBuffer | null = null
  onended: (() => void) | null = null
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
  readonly start = vi.fn()
  readonly stop = vi.fn()

  finish() {
    this.onended?.()
  }
}

describe('StreamingTextChunker', () => {
  it('emits sentence chunks as streaming text arrives', () => {
    const chunker = new StreamingTextChunker()

    expect(chunker.append('Hello there. How')).toEqual(['Hello there.'])
    expect(chunker.append(' are you today?')).toEqual(['How are you today?'])
  })

  it('falls back to a clause boundary when there is no completed sentence yet', () => {
    const chunker = new StreamingTextChunker()
    const longText = `${'x'.repeat(VOICE_CHUNK_SOFT_LIMIT - 10)}, ${'y'.repeat(30)}`

    expect(chunker.append(longText)).toEqual([`${'x'.repeat(VOICE_CHUNK_SOFT_LIMIT - 10)},`])
  })

  it('flushes any remaining partial text at the end of a turn', () => {
    const chunker = new StreamingTextChunker()

    expect(chunker.append('Partial')).toEqual([])
    expect(chunker.flush()).toEqual(['Partial'])
  })
})

describe('pcm16ToFloat32', () => {
  it('decodes little-endian 16-bit PCM samples', () => {
    const samples = new Int16Array([32767, -32768, 0])

    expect(Array.from(pcm16ToFloat32(samples.buffer))).toEqual([32767 / 32768, -1, 0])
  })
})

describe('PcmAudioPlayer', () => {
  it('schedules sequential chunks and reports playback state changes', () => {
    const stateChanges: Array<'idle' | 'playing'> = []
    const sources: MockAudioBufferSourceNode[] = []
    const audioContext = {
      currentTime: 1,
      destination: {} as AudioNode,
      createBuffer: vi.fn((channels: number, length: number, sampleRate: number) => {
        expect(channels).toBe(1)
        return new MockAudioBuffer(length, sampleRate)
      }),
      createBufferSource: vi.fn(() => {
        const source = new MockAudioBufferSourceNode()
        sources.push(source)
        return source as unknown as AudioBufferSourceNode
      }),
    }
    const player = new PcmAudioPlayer(audioContext, {
      sampleRate: 24000,
      onStateChange: (state) => stateChanges.push(state),
    })
    const chunk = new Int16Array([0, 1000, -1000]).buffer

    player.enqueueChunk(chunk)
    player.enqueueChunk(chunk)

    expect(sources[0]?.start.mock.calls[0]?.[0]).toBeCloseTo(1.15)
    expect(sources[1]?.start.mock.calls[0]?.[0]).toBeCloseTo(1.150125)
    expect(stateChanges).toEqual(['playing'])

    sources[0]?.finish()
    expect(stateChanges).toEqual(['playing'])

    sources[1]?.finish()
    expect(stateChanges).toEqual(['playing', 'idle'])
  })

  it('stops queued playback and resets to idle', () => {
    const stateChanges: Array<'idle' | 'playing'> = []
    const source = new MockAudioBufferSourceNode()
    const audioContext = {
      currentTime: 0,
      destination: {} as AudioNode,
      createBuffer: vi.fn((_channels: number, length: number, sampleRate: number) => {
        return new MockAudioBuffer(length, sampleRate)
      }),
      createBufferSource: vi.fn(() => source as unknown as AudioBufferSourceNode),
    }
    const player = new PcmAudioPlayer(audioContext, {
      onStateChange: (state) => stateChanges.push(state),
    })

    player.enqueueChunk(new Int16Array([0, 500]).buffer)
    player.stop()

    expect(source.stop).toHaveBeenCalled()
    expect(source.disconnect).toHaveBeenCalled()
    expect(stateChanges).toEqual(['playing', 'idle'])
  })
})
