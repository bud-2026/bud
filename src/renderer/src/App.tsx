import { FormEvent, useEffect, useRef, useState } from 'react'
import Indicator from './components/Indicator'
import { askScreen } from './lib/ai'

function App(): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [ttsText, setTtsText] = useState('')
  const [result, setResult] = useState<ScreenAIResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isTtsLoading, setIsTtsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isOverlayFocused, setIsOverlayFocused] = useState(true)
  const [isDebugOpen, setIsDebugOpen] = useState(true)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextAudioTimeRef = useRef<number>(0)

  useEffect(() => window.api.overlay.onFocusChanged(setIsOverlayFocused), [])
  useEffect(() => {
    const unsubscribeStart = window.api.tts.onStart(({ sampleRate }) => {
      audioContextRef.current ??= new AudioContext({ sampleRate })
      void audioContextRef.current.resume()
      nextAudioTimeRef.current = Math.max(
        audioContextRef.current.currentTime,
        nextAudioTimeRef.current
      )
      setIsSpeaking(true)
    })
    const unsubscribeChunk = window.api.tts.onChunk(({ chunk }) => {
      const context = audioContextRef.current
      if (!context) return

      const sampleCount = Math.floor(chunk.byteLength / Float32Array.BYTES_PER_ELEMENT)
      const samples = new Float32Array(sampleCount)
      samples.set(new Float32Array(chunk.buffer, chunk.byteOffset, sampleCount))
      const audioBuffer = context.createBuffer(1, sampleCount, context.sampleRate)
      audioBuffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = audioBuffer
      source.connect(context.destination)
      const startTime = Math.max(context.currentTime, nextAudioTimeRef.current)
      source.start(startTime)
      nextAudioTimeRef.current = startTime + audioBuffer.duration
    })
    const unsubscribeEnd = window.api.tts.onEnd(() => setIsSpeaking(false))
    const unsubscribeError = window.api.tts.onError((message) => {
      setIsSpeaking(false)
      setError(message)
    })

    return () => {
      unsubscribeStart()
      unsubscribeChunk()
      unsubscribeEnd()
      unsubscribeError()
      void audioContextRef.current?.close()
    }
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const prompt = question.trim()

    if (!prompt || isLoading) return

    setIsLoading(true)
    setError(null)
    try {
      setResult(await askScreen(prompt))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Screen analysis failed')
    } finally {
      setIsLoading(false)
    }
  }

  const handleTtsSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const text = ttsText.trim()

    if (!text || isTtsLoading) return

    setIsTtsLoading(true)
    setError(null)
    try {
      await window.api.tts.speak(text)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'TTS request failed')
    } finally {
      setIsTtsLoading(false)
    }
  }

  const clearBoundingBoxes = (): void => {
    setResult((currentResult) => (currentResult ? { ...currentResult, boxes: [] } : currentResult))
  }

  return (
    <main className="overlay" aria-label="Screen overlay">
      <section className={`debug-panel${isDebugOpen ? '' : ' debug-panel--collapsed'}`}>
        <button
          className="debug-panel__toggle"
          type="button"
          onClick={() => setIsDebugOpen((open) => !open)}
          aria-expanded={isDebugOpen}
        >
          {isDebugOpen ? 'Hide debug' : 'Show debug'}
        </button>
        {isDebugOpen && (
          <div className="debug-panel__content">
            <form className="question-panel" onSubmit={handleSubmit}>
              <label htmlFor="screen-question">
                Ask about your screen
                <span className="question-panel__shortcut">
                  {isSpeaking ? 'Speaking · ' : ''}Ctrl+Shift+Space to{' '}
                  {isOverlayFocused ? 'unfocus' : 'focus'}
                </span>
              </label>
              <div className="question-panel__controls">
                <input
                  id="screen-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="What is on my screen?"
                  disabled={isLoading}
                />
                <button type="submit" disabled={isLoading || !question.trim()}>
                  {isLoading ? 'Analyzing...' : 'Ask'}
                </button>
              </div>
              {result && <p className="question-panel__response">{result.text}</p>}
            </form>
            <form className="question-panel" onSubmit={handleTtsSubmit}>
              <label htmlFor="tts-text">Test text-to-speech</label>
              <div className="question-panel__controls">
                <input
                  id="tts-text"
                  value={ttsText}
                  onChange={(event) => setTtsText(event.target.value)}
                  placeholder="Type text to speak..."
                  disabled={isTtsLoading}
                />
                <button type="submit" disabled={isTtsLoading || !ttsText.trim()}>
                  {isTtsLoading ? 'Sending...' : 'Speak'}
                </button>
              </div>
            </form>
            <button
              className="debug-panel__clear"
              type="button"
              onClick={clearBoundingBoxes}
              disabled={!result?.boxes.length}
            >
              Clear bounding boxes
            </button>
            {error && <p className="question-panel__error">{error}</p>}
          </div>
        )}
      </section>
      {result?.boxes.map((box, index) => (
        <Indicator
          key={`${box.topLeft.x}-${box.topLeft.y}-${index}`}
          topLeft={box.topLeft}
          bottomRight={box.bottomRight}
          label={box.label}
        />
      ))}
    </main>
  )
}

export default App
