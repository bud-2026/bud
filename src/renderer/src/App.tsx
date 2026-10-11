import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import Indicator from './components/Indicator'
import RegionSelector from './components/RegionSelector'
import VoiceOrb from './components/VoiceOrb'
import { askQuestion } from './lib/ai'

const VOICE_HISTORY_MESSAGE_LIMIT = 20

function formatMegabytes(bytes: number): string {
  return `${Math.floor(bytes / 1e6)} MB`
}

function describeVlStatus(status: VlComponentStatus): string {
  switch (status.phase) {
    case 'pending':
      return 'Waiting…'
    case 'downloading': {
      if (status.total && status.received !== undefined) {
        const percent = Math.floor((status.received / status.total) * 100)
        return `Downloading ${formatMegabytes(status.received)} / ${formatMegabytes(
          status.total
        )} (${percent}%)`
      }
      return 'Downloading…'
    }
    case 'downloaded':
      return 'Downloaded'
    case 'starting':
      return 'Starting…'
    case 'ready':
      return 'Ready'
    case 'error':
      return 'Failed'
  }
}

interface VlStatusRowProps {
  label: string
  version: string
  status: VlComponentStatus
}

function VlStatusRow({ label, version, status }: VlStatusRowProps): React.JSX.Element {
  const isDownloading = status.phase === 'downloading'
  const percent =
    isDownloading && status.total
      ? Math.min(100, Math.floor(((status.received ?? 0) / status.total) * 100))
      : 0

  return (
    <li className="model-status__row">
      <div className="model-status__head">
        <span className="model-status__label">{label}</span>
        <span className={`model-status__state model-status__state--${status.phase}`}>
          {describeVlStatus(status)}
        </span>
      </div>
      <span className="model-status__version">{version}</span>
      {isDownloading && percent > 0 ? (
        <div
          className="model-status__bar"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="model-status__bar-fill" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {status.phase === 'error' && status.message ? (
        <span className="model-status__message">{status.message}</span>
      ) : null}
    </li>
  )
}

function App(): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [ttsText, setTtsText] = useState('')
  const [aiSettings, setAiSettings] = useState<AISettings>({
    generalBaseUrl: '',
    generalApiKey: '',
    generalModelId: ''
  })
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [result, setResult] = useState<ScreenAIResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isTtsLoading, setIsTtsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDebugOpen, setIsDebugOpen] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState('Starting voice listener...')
  const [vlStatus, setVlStatus] = useState<VlStatusSnapshot | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceOrbState, setVoiceOrbState] = useState<
    'hidden' | 'listening' | 'analyzing' | 'responding'
  >('hidden')
  const [isOrbExiting, setIsOrbExiting] = useState(false)
  const [region, setRegion] = useState<Region | null>(null)
  const [isSelecting, setIsSelecting] = useState(false)
  const [isAutoListen, setIsAutoListen] = useState(false)
  const voiceOrbStateRef = useRef(voiceOrbState)
  const regionRef = useRef<Region | null>(null)
  const autoListenRef = useRef(false)
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
      if (autoListenRef.current) return
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

  const startAutoListen = useCallback((): void => {
    setIsAutoListen(true)
    autoListenRef.current = true
    voiceSessionEndedRef.current = false
    voiceSessionActiveRef.current = true
    void window.api.voice.setListenMode(true).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : 'Could not enable continuous listening')
    })
  }, [])

  const stopAutoListen = useCallback((): void => {
    setIsAutoListen(false)
    autoListenRef.current = false
    void window.api.voice.setListenMode(false).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : 'Could not disable continuous listening')
    })
    void window.api.voice.stopSession().catch((error: unknown) => {
      setError(error instanceof Error ? error.message : 'Could not stop voice listening')
    })
  }, [])

  const startRegionSelection = useCallback((): void => {
    stopAutoListen()
    setIsSelecting(true)
    window.api.overlay.setSelectMode(true)
  }, [stopAutoListen])

  const finishRegionSelection = useCallback(
    (nextRegion: Region): void => {
      setRegion(nextRegion)
      regionRef.current = nextRegion
      setIsSelecting(false)
      window.api.overlay.setSelectMode(false)
      startAutoListen()
      setVoiceStatus('Auto-listening in selected area · Esc to stop')
    },
    [startAutoListen]
  )

  const cancelRegionSelection = useCallback((): void => {
    setIsSelecting(false)
    window.api.overlay.setSelectMode(false)
    // Esc during a re-selection leaves an existing region in place, so resume
    // auto-listening instead of stranding the user in a non-listening state.
    if (regionRef.current) startAutoListen()
  }, [startAutoListen])

  const handleRegionControlClick = useCallback((): void => {
    if (regionRef.current && autoListenRef.current) {
      stopAutoListen()
      return
    }
    if (regionRef.current) {
      startAutoListen()
      return
    }
    startRegionSelection()
  }, [startAutoListen, stopAutoListen, startRegionSelection])

  const clearRegion = useCallback((): void => {
    setRegion(null)
    regionRef.current = null
    stopAutoListen()
    voiceSessionActiveRef.current = false
    voiceSessionEndedRef.current = true
    hideOrbWithAnimation()
  }, [stopAutoListen, hideOrbWithAnimation])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (isSelecting) return
      clearRegion()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSelecting, clearRegion])

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
  useEffect(() => {
    let disposed = false
    void window.api.vl
      .getStatus()
      .then((status) => {
        if (!disposed) setVlStatus(status)
      })
      .catch(() => {
        // Status is informational; live updates arrive through onStatus below.
      })
    const unsubscribe = window.api.vl.onStatus((status) => setVlStatus(status))
    return () => {
      disposed = true
      unsubscribe()
    }
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
            if (autoListenRef.current) {
              clearRegion()
              setVoiceStatus('Stopped listening · selected area cleared')
              return
            }
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
          void askQuestion(
            userText,
            voiceConversationHistoryRef.current,
            regionRef.current ?? undefined
          )
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
          listening: event.auto
            ? 'Auto-listening in selected area…'
            : `Listening for “${event.wake_word ?? 'hey bud'}”`,
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
    [
      clearRegion,
      clearVoiceInactivityTimer,
      hideOrbWithAnimation,
      resetVoiceInactivityTimer,
      setOrbState
    ]
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
      const screenResponse = await askQuestion(
        prompt,
        screenConversationHistoryRef.current,
        regionRef.current ?? undefined
      )
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

  return (
    <main className="overlay" aria-label="Screen overlay">
      {voiceOrbState !== 'hidden' && <VoiceOrb state={voiceOrbState} exiting={isOrbExiting} />}
      {region && !isSelecting && (
        <div
          className="region-outline"
          style={{
            left: `${region.x / 10}%`,
            top: `${region.y / 10}%`,
            width: `${region.width / 10}%`,
            height: `${region.height / 10}%`
          }}
          aria-hidden="true"
        />
      )}
      <section
        className={`debug-panel${isDebugOpen ? ' debug-panel--open' : ''}`}
        aria-hidden={!isDebugOpen}
      >
        <div className="debug-panel__content">
          <h1 className="debug-panel__title">Settings Panel</h1>
          <div className="question-panel">
            <label htmlFor="screen-question">Ctrl+Shift+Space to toggle panel</label>
            <h2 className="question-panel__title">Installations</h2>
            {vlStatus ? (
              <ul className="model-status">
                <VlStatusRow
                  label="llama.cpp runtime"
                  version={`build ${vlStatus.llamaVersion} · ${vlStatus.llamaBackend}`}
                  status={vlStatus.runtime}
                />
                <VlStatusRow
                  label="Vision model"
                  version={`${vlStatus.modelAlias} · ${vlStatus.modelQuant}`}
                  status={vlStatus.model}
                />
                <VlStatusRow
                  label="Vision projector"
                  version={`mmproj · ${vlStatus.mmprojQuant}`}
                  status={vlStatus.mmproj}
                />
                <VlStatusRow
                  label="Inference server"
                  version={vlStatus.port ? `127.0.0.1:${vlStatus.port}` : 'Not running'}
                  status={vlStatus.server}
                />
              </ul>
            ) : (
              <p className="question-panel__voice-status">Checking local model…</p>
            )}
          </div>

          <form className="question-panel" onSubmit={handleSettingsSubmit}>
            <h2 className="question-panel__title">AI Settings</h2>
            <div className="ai-settings__group">
              <strong>General responses</strong>
              <input
                value={aiSettings.generalBaseUrl}
                onChange={(event) =>
                  setAiSettings({ ...aiSettings, generalBaseUrl: event.target.value })
                }
                placeholder="General base URL"
                disabled={isSavingSettings}
              />
              <input
                type="password"
                value={aiSettings.generalApiKey}
                onChange={(event) =>
                  setAiSettings({ ...aiSettings, generalApiKey: event.target.value })
                }
                placeholder="General API key"
                disabled={isSavingSettings}
              />
              <input
                value={aiSettings.generalModelId}
                onChange={(event) =>
                  setAiSettings({ ...aiSettings, generalModelId: event.target.value })
                }
                placeholder="General model ID"
                disabled={isSavingSettings}
              />
            </div>
            <div className="question-panel__controls">
              <button type="submit" disabled={isSavingSettings}>
                Save
              </button>
            </div>
          </form>

          <form className="question-panel" onSubmit={handleSubmit}>
            <h2 className="question-panel__title">Debug</h2>
            <p className="question-panel__voice-status">{voiceStatus}</p>
            <div className="region-control">
              <button type="button" onClick={handleRegionControlClick} disabled={isSelecting}>
                {isSelecting
                  ? 'Selecting…'
                  : region
                    ? isAutoListen
                      ? 'Stop listening'
                      : 'Start listening'
                    : 'Select area to analyze'}
              </button>
              <span className="region-control__status">
                {region
                  ? isAutoListen
                    ? `Area selected (${region.width}×${region.height} of 1000) · auto-listening`
                    : `Area selected (${region.width}×${region.height} of 1000)`
                  : 'Analyzing the full screen'}
              </span>
            </div>
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
      {isSelecting && (
        <RegionSelector onComplete={finishRegionSelection} onCancel={cancelRegionSelection} />
      )}
    </main>
  )
}

export default App
