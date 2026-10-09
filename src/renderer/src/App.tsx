import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import Indicator from './components/Indicator'
import VoiceOrb from './components/VoiceOrb'
import { askScreen } from './lib/ai'

const VOICE_HISTORY_MESSAGE_LIMIT = 20

function App(): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [ttsText, setTtsText] = useState('')
  const [aiSettings, setAiSettings] = useState<AISettings>({
    baseUrl: '',
    apiKey: '',
    modelId: ''
  })
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [result, setResult] = useState<ScreenAIResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isTtsLoading, setIsTtsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDebugOpen, setIsDebugOpen] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState('Starting voice listener...')
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceOrbState, setVoiceOrbState] = useState<
    'hidden' | 'listening' | 'analyzing' | 'responding'
  >('hidden')
  const [isOrbExiting, setIsOrbExiting] = useState(false)
  const voiceOrbStateRef = useRef(voiceOrbState)
  const isLoadingRef = useRef(false)
  const isSpeakingRef = useRef(false)
  const voiceSessionActiveRef = useRef(false)
  const voiceSessionEndedRef = useRef(false)
  const orbHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceInactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const boxesClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingBoxClearRef = useRef(false)
  const screenConversationHistoryRef = useRef<ScreenConversationMessage[]>([])
  const voiceConversationHistoryRef = useRef<ScreenConversationMessage[]>([])

  const setOrbState = useCallback(
    (state: 'hidden' | 'listening' | 'analyzing' | 'responding'): void => {
      voiceOrbStateRef.current = state
      if (state !== 'hidden') setIsOrbExiting(false)
      setVoiceOrbState(state)
    },
    []
  )
  const hideOrbWithAnimation = useCallback((): void => {
    if (orbHideTimerRef.current) clearTimeout(orbHideTimerRef.current)
    setIsOrbExiting(true)
    orbHideTimerRef.current = setTimeout(() => {
      setIsOrbExiting(false)
      setOrbState('hidden')
    }, 220)
  }, [setOrbState])
  const resetVoiceInactivityTimer = useCallback((): void => {
    if (voiceInactivityTimerRef.current) clearTimeout(voiceInactivityTimerRef.current)
    voiceInactivityTimerRef.current = setTimeout(() => {
      voiceSessionActiveRef.current = false
      voiceSessionEndedRef.current = true
      void window.api.voice.stopSession().catch((error: unknown) => {
        setError(error instanceof Error ? error.message : 'Could not stop voice listening')
      })
      hideOrbWithAnimation()
    }, 10_000)
  }, [hideOrbWithAnimation])
  const clearVoiceInactivityTimer = useCallback((): void => {
    if (voiceInactivityTimerRef.current) {
      clearTimeout(voiceInactivityTimerRef.current)
      voiceInactivityTimerRef.current = null
    }
  }, [])
  const scheduleBoundingBoxClear = (): void => {
    if (boxesClearTimerRef.current) clearTimeout(boxesClearTimerRef.current)
    boxesClearTimerRef.current = setTimeout(() => {
      setResult((currentResult) =>
        currentResult ? { ...currentResult, boxes: [] } : currentResult
      )
    }, 2000)
  }
  const audioContextRef = useRef<AudioContext | null>(null)
  const nextAudioTimeRef = useRef<number>(0)

  useEffect(() => window.api.overlay.onDebugVisibilityChanged(setIsDebugOpen), [])
  useEffect(() => {
    if (isDebugOpen) return

    let interactive = false
    const handleMouseMove = (event: MouseEvent): void => {
      const nextInteractive =
        event.target instanceof Element && Boolean(event.target.closest('.indicator__copy-btn'))
      if (nextInteractive === interactive) return
      interactive = nextInteractive
      window.api.overlay.setInteractive(interactive)
    }

    document.addEventListener('mousemove', handleMouseMove)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      if (interactive) window.api.overlay.setInteractive(false)
    }
  }, [isDebugOpen])
  useEffect(() => {
    void window.api.settings
      .getAI()
      .then(setAiSettings)
      .catch((requestError: unknown) => {
        setError(
          requestError instanceof Error ? requestError.message : 'Could not load AI settings'
        )
      })
  }, [])
  useEffect(
    () =>
      window.api.voice.onEvent((event) => {
        if (event.event === 'error') {
          voiceSessionActiveRef.current = false
          voiceSessionEndedRef.current = false
          if (voiceInactivityTimerRef.current) clearTimeout(voiceInactivityTimerRef.current)
          setVoiceStatus('Voice error')
          setError(event.message ?? 'Voice listener failed')
          return
        }
        if (event.event === 'status') {
          setVoiceStatus(event.message ?? 'Preparing voice listener...')
          return
        }

        if (event.event === 'transcript' && event.text) {
          if (voiceSessionEndedRef.current) return
          voiceSessionActiveRef.current = true
          if (voiceOrbStateRef.current !== 'analyzing' && !isSpeakingRef.current) {
            setOrbState('listening')
            resetVoiceInactivityTimer()
          }
          setVoiceTranscript(event.text)
        }
        if (event.event === 'final' && event.text) {
          const userText = event.text
          if (event.end_session) {
            voiceSessionActiveRef.current = false
            voiceSessionEndedRef.current = true
            clearVoiceInactivityTimer()
            setVoiceStatus('Conversation ended · say the wake word to start again')
            hideOrbWithAnimation()
            return
          }
          if (voiceInactivityTimerRef.current) clearTimeout(voiceInactivityTimerRef.current)
          setOrbState('analyzing')
          setVoiceTranscript(userText)
          setQuestion(userText)
          setVoiceStatus('Analyzing voice question...')
          setIsLoading(true)
          isLoadingRef.current = true
          pendingBoxClearRef.current = true
          setError(null)
          void askScreen(userText, voiceConversationHistoryRef.current)
            .then((screenResponse) => {
              voiceConversationHistoryRef.current = [
                ...voiceConversationHistoryRef.current,
                { role: 'user' as const, content: userText },
                { role: 'assistant' as const, content: screenResponse.text }
              ].slice(-VOICE_HISTORY_MESSAGE_LIMIT)
              setResult(screenResponse)
            })
            .catch((requestError: unknown) => {
              pendingBoxClearRef.current = false
              setError(
                requestError instanceof Error ? requestError.message : 'Screen analysis failed'
              )
            })
            .finally(() => {
              setIsLoading(false)
              isLoadingRef.current = false
            })
          return
        }

        const statuses: Record<string, string> = {
          ready: `Voice listener ready · say “${event.wake_word ?? 'hey bud'}”`,
          listening: `Listening for “${event.wake_word ?? 'hey bud'}”`,
          wake_detected: 'Wake word detected',
          transcribing: 'Listening for your question...'
        }
        if (event.event === 'wake_detected') {
          voiceSessionEndedRef.current = false
          voiceSessionActiveRef.current = true
          resetVoiceInactivityTimer()
          if (!isLoadingRef.current && !isSpeakingRef.current) setOrbState('listening')
        } else if (event.event === 'transcribing' && !voiceSessionEndedRef.current) {
          voiceSessionActiveRef.current = true
          resetVoiceInactivityTimer()
          if (!isLoadingRef.current && !isSpeakingRef.current) setOrbState('listening')
        }
        setVoiceStatus(statuses[event.event] ?? event.event)
      }),
    [clearVoiceInactivityTimer, hideOrbWithAnimation, resetVoiceInactivityTimer, setOrbState]
  )
  useEffect(() => {
    const unsubscribeStart = window.api.tts.onStart(({ sampleRate }) => {
      if (orbHideTimerRef.current) clearTimeout(orbHideTimerRef.current)
      clearVoiceInactivityTimer()
      setOrbState('responding')
      isSpeakingRef.current = true
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
    const unsubscribeEnd = window.api.tts.onEnd(() => {
      const context = audioContextRef.current
      const remainingAudioMs = context
        ? Math.max(0, (nextAudioTimeRef.current - context.currentTime) * 1000)
        : 0

      orbHideTimerRef.current = setTimeout(() => {
        if (pendingBoxClearRef.current) {
          scheduleBoundingBoxClear()
          pendingBoxClearRef.current = false
        }
        setIsSpeaking(false)
        isSpeakingRef.current = false
        if (voiceSessionActiveRef.current) {
          setOrbState('listening')
          resetVoiceInactivityTimer()
          return
        }
        hideOrbWithAnimation()
      }, remainingAudioMs)
    })
    const unsubscribeError = window.api.tts.onError((message) => {
      if (pendingBoxClearRef.current) {
        scheduleBoundingBoxClear()
        pendingBoxClearRef.current = false
      }
      setIsSpeaking(false)
      isSpeakingRef.current = false
      setOrbState('hidden')
      setError(message)
    })

    return () => {
      unsubscribeStart()
      unsubscribeChunk()
      unsubscribeEnd()
      unsubscribeError()
      if (orbHideTimerRef.current) clearTimeout(orbHideTimerRef.current)
      if (voiceInactivityTimerRef.current) clearTimeout(voiceInactivityTimerRef.current)
      if (boxesClearTimerRef.current) clearTimeout(boxesClearTimerRef.current)
      void audioContextRef.current?.close()
    }
  }, [clearVoiceInactivityTimer, hideOrbWithAnimation, resetVoiceInactivityTimer, setOrbState])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const prompt = question.trim()

    if (!prompt || isLoading) return

    setIsLoading(true)
    isLoadingRef.current = true
    setOrbState('analyzing')
    setError(null)
    if (boxesClearTimerRef.current) clearTimeout(boxesClearTimerRef.current)
    pendingBoxClearRef.current = true
    try {
      const screenResponse = await askScreen(prompt, screenConversationHistoryRef.current)
      screenConversationHistoryRef.current = [
        ...screenConversationHistoryRef.current,
        { role: 'user' as const, content: prompt },
        { role: 'assistant' as const, content: screenResponse.text }
      ].slice(-8)
      setResult(screenResponse)
    } catch (requestError) {
      pendingBoxClearRef.current = false
      setError(requestError instanceof Error ? requestError.message : 'Screen analysis failed')
    } finally {
      setIsLoading(false)
      isLoadingRef.current = false
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

  const handleSettingsSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setIsSavingSettings(true)
    setError(null)
    try {
      setAiSettings(await window.api.settings.saveAI(aiSettings))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not save AI settings')
    } finally {
      setIsSavingSettings(false)
    }
  }

  const clearBoundingBoxes = (): void => {
    if (boxesClearTimerRef.current) clearTimeout(boxesClearTimerRef.current)
    pendingBoxClearRef.current = false
    setResult((currentResult) => (currentResult ? { ...currentResult, boxes: [] } : currentResult))
  }

  return (
    <main className="overlay" aria-label="Screen overlay">
      {voiceOrbState !== 'hidden' && <VoiceOrb state={voiceOrbState} exiting={isOrbExiting} />}
      <section
        className={`debug-panel${isDebugOpen ? ' debug-panel--open' : ''}`}
        aria-hidden={!isDebugOpen}
      >
        <div className="debug-panel__content">
          <form className="question-panel" onSubmit={handleSubmit}>
            <label htmlFor="screen-question">
              Ask about your screen
              <span className="question-panel__shortcut">
                {isSpeaking ? 'Speaking · ' : ''}Ctrl+Shift+Space to toggle debug
              </span>
            </label>
            <p className="question-panel__voice-status">{voiceStatus}</p>
            <div className="question-panel__controls">
              <input
                id="screen-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="What is on my screen?"
                disabled={isLoading}
              />
              <button type="submit" disabled={isLoading || !question.trim()}>
                Ask
              </button>
            </div>
            {result && <p className="question-panel__response">{result.text}</p>}
            {voiceTranscript && (
              <p className="question-panel__transcript">Heard: {voiceTranscript}</p>
            )}
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
                Speak
              </button>
            </div>
          </form>
          <form className="question-panel" onSubmit={handleSettingsSubmit}>
            <label htmlFor="ai-base-url">AI settings</label>
            <input
              id="ai-base-url"
              value={aiSettings.baseUrl}
              onChange={(event) => setAiSettings({ ...aiSettings, baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1/"
              disabled={isSavingSettings}
            />
            <input
              type="password"
              value={aiSettings.apiKey}
              onChange={(event) => setAiSettings({ ...aiSettings, apiKey: event.target.value })}
              placeholder="API key"
              disabled={isSavingSettings}
              aria-label="AI API key"
            />
            <div className="question-panel__controls">
              <input
                value={aiSettings.modelId}
                onChange={(event) => setAiSettings({ ...aiSettings, modelId: event.target.value })}
                placeholder="Model ID"
                disabled={isSavingSettings}
                aria-label="AI model ID"
              />
              <button type="submit" disabled={isSavingSettings}>
                Save
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
      </section>
      {result?.boxes.map((box, index) => (
        <Indicator
          key={`${box.bbox.join('-')}-${index}`}
          bbox={box.bbox}
          label={box.label}
          copy={box.copy}
        />
      ))}
    </main>
  )
}

export default App
