export const DEEPGRAM_STREAM_ENCODING = 'linear16'
export const DEEPGRAM_STREAM_SAMPLE_RATE = 24000
export const VOICE_CHUNK_SOFT_LIMIT = 140

const SENTENCE_BOUNDARY_PATTERN = /[.!?](?=(?:["')\]]*)\s|$)/g
const CLAUSE_BOUNDARY_PATTERN = /[,;:](?=\s|$)|[—–-](?=\s|$)/g

function normalizeChunkText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function trimLeadingWhitespace(text: string): string {
  return text.replace(/^\s+/, '')
}

function findLastBoundaryIndex(pattern: RegExp, text: string, limit = text.length): number | null {
  pattern.lastIndex = 0
  let boundaryIndex: number | null = null
  let match = pattern.exec(text)

  while (match) {
    const matchEnd = match.index + match[0].length
    if (matchEnd > limit) {
      break
    }

    boundaryIndex = matchEnd
    match = pattern.exec(text)
  }

  return boundaryIndex
}

function splitChunk(buffer: string, boundaryIndex: number) {
  const chunk = normalizeChunkText(buffer.slice(0, boundaryIndex))
  const remainder = trimLeadingWhitespace(buffer.slice(boundaryIndex))

  return {
    chunk,
    remainder,
  }
}

export class StreamingTextChunker {
  private buffer = ''

  append(textDelta: string): string[] {
    if (!textDelta) {
      return []
    }

    this.buffer += textDelta
    return this.drain(false)
  }

  flush(): string[] {
    return this.drain(true)
  }

  reset() {
    this.buffer = ''
  }

  private drain(forceFinal: boolean): string[] {
    const chunks: string[] = []

    while (this.buffer) {
      const sentenceBoundary = findLastBoundaryIndex(SENTENCE_BOUNDARY_PATTERN, this.buffer)

      if (sentenceBoundary) {
        const { chunk, remainder } = splitChunk(this.buffer, sentenceBoundary)
        this.buffer = remainder

        if (chunk) {
          chunks.push(chunk)
        }
        continue
      }

      if (!forceFinal && this.buffer.length <= VOICE_CHUNK_SOFT_LIMIT) {
        break
      }

      const clauseBoundary = findLastBoundaryIndex(
        CLAUSE_BOUNDARY_PATTERN,
        this.buffer,
        VOICE_CHUNK_SOFT_LIMIT,
      )
      if (clauseBoundary) {
        const { chunk, remainder } = splitChunk(this.buffer, clauseBoundary)
        this.buffer = remainder

        if (chunk) {
          chunks.push(chunk)
        }
        continue
      }

      if (!forceFinal) {
        const whitespaceBoundary = this.buffer.lastIndexOf(' ', VOICE_CHUNK_SOFT_LIMIT)
        if (whitespaceBoundary > 0) {
          const { chunk, remainder } = splitChunk(this.buffer, whitespaceBoundary)
          this.buffer = remainder

          if (chunk) {
            chunks.push(chunk)
          }
        }
        break
      }

      const finalChunk = normalizeChunkText(this.buffer)
      this.buffer = ''

      if (finalChunk) {
        chunks.push(finalChunk)
      }
    }

    return chunks
  }
}

export function pcm16ToFloat32(buffer: ArrayBuffer): Float32Array {
  const sampleCount = Math.floor(buffer.byteLength / 2)
  const view = new DataView(buffer)
  const samples = new Float32Array(sampleCount)

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768
  }

  return samples
}

type AudioContextLike = Pick<
  AudioContext,
  'createBuffer' | 'createBufferSource' | 'currentTime'
> & {
  destination: AudioNode
}

type AudioPlayerState = 'idle' | 'playing'

export class PcmAudioPlayer {
  private activeSources = new Set<AudioBufferSourceNode>()
  private generation = 0
  private nextStartTime = 0
  private state: AudioPlayerState = 'idle'

  constructor(
    private readonly audioContext: AudioContextLike,
    private readonly options: {
      sampleRate?: number
      initialBufferMs?: number
      onStateChange?: (state: AudioPlayerState) => void
    } = {},
  ) {}

  enqueueChunk(buffer: ArrayBuffer) {
    const samples = pcm16ToFloat32(buffer)
    if (!samples.length) {
      return
    }

    const sampleRate = this.options.sampleRate ?? DEEPGRAM_STREAM_SAMPLE_RATE
    const audioBuffer = this.audioContext.createBuffer(1, samples.length, sampleRate)
    audioBuffer.getChannelData(0).set(samples)

    const source = this.audioContext.createBufferSource()
    source.buffer = audioBuffer
    source.connect(this.audioContext.destination)

    const leadTime = this.nextStartTime === 0 ? (this.options.initialBufferMs ?? 150) / 1000 : 0.02
    const startTime = Math.max(this.nextStartTime || 0, this.audioContext.currentTime + leadTime)
    const generation = this.generation

    this.nextStartTime = startTime + audioBuffer.duration
    this.activeSources.add(source)
    this.setState('playing')

    source.onended = () => {
      if (generation !== this.generation) {
        return
      }

      this.activeSources.delete(source)

      if (this.activeSources.size === 0) {
        this.nextStartTime = 0
        this.setState('idle')
      }
    }

    source.start(startTime)
  }

  stop() {
    this.generation += 1
    this.nextStartTime = 0

    for (const source of this.activeSources) {
      source.onended = null
      try {
        source.stop()
      } catch {}
      source.disconnect()
    }

    this.activeSources.clear()
    this.setState('idle')
  }

  private setState(state: AudioPlayerState) {
    if (this.state === state) {
      return
    }

    this.state = state
    this.options.onStateChange?.(state)
  }
}
