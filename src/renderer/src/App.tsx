import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import AskBar from './components/AskBar'
import Indicator from './components/Indicator'
import RegionSelector from './components/RegionSelector'
import Toolbar, { type ToolbarEdge } from './components/Toolbar'
import VoiceOrb from './components/VoiceOrb'
import { askQuestion } from './lib/ai'

const VOICE_HISTORY_MESSAGE_LIMIT = 20
const TOOLBAR_EDGE_INSET = 8
const TOOLBAR_STATE_STORAGE_KEY = 'bud-toolbar-state'
const TOOLBAR_LEGACY_X_STORAGE_KEY = 'bud-toolbar-x'

interface ToolbarState {
  edge: ToolbarEdge
  position: number
}

function isToolbarEdge(value: unknown): value is ToolbarEdge {
  return value === 'top' || value === 'bottom' || value === 'left' || value === 'right'
}

function clampToolbarPosition(position: number): number {
  return Math.min(96, Math.max(4, position))
}

function readStoredToolbarState(): ToolbarState {
  try {
    const raw = window.localStorage.getItem(TOOLBAR_STATE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { edge?: unknown; position?: unknown }
      const position = Number(parsed.position)
      if (isToolbarEdge(parsed.edge) && Number.isFinite(position)) {
        return { edge: parsed.edge, position: clampToolbarPosition(position) }
      }
    }
    const legacy = window.localStorage.getItem(TOOLBAR_LEGACY_X_STORAGE_KEY)
    if (legacy !== null) {
      const legacyPosition = Number(legacy)
      if (Number.isFinite(legacyPosition)) {
        return { edge: 'top', position: clampToolbarPosition(legacyPosition) }
      }
    }
  } catch {
    // Ignore malformed stored values and fall back to defaults.
  }
  return { edge: 'top', position: 50 }
}

function formatMegabytes(bytes: number): string {
  return `${Math.floor(bytes / 1e6)} MB`
}

// Shared status shape for every bundled component (vision, speech, TTS). The
// vision server reports byte progress and a `downloaded` phase; the speech
// backends additionally use `loading` and `off`.
type ComponentPhase = VlPhase | BackendPhase

interface ComponentStatus {
  phase: ComponentPhase
  received?: number
  total?: number
  detail?: string
  message?: string
}

function describeStatus(status: ComponentStatus): string {
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
    case 'loading':
      return 'Loading…'
    case 'downloaded':
      return 'Downloaded'
    case 'starting':
      return 'Starting…'
    case 'ready':
      return 'Ready'
    case 'error':
      return 'Failed'
    case 'off':
      return 'Off'
  }
}

interface ModelStatusRowProps {
  label: string
  version: string
  status: ComponentStatus
}

function ModelStatusRow({ label, version, status }: ModelStatusRowProps): React.JSX.Element {
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
          {describeStatus(status)}
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
  const [sttStatus, setSttStatus] = useState<SttStatusSnapshot | null>(null)
  const [ttsStatus, setTtsStatus] = useState<BackendComponentStatus | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState('')
  const [voiceOrbState, setVoiceOrbState] = useState<
    'hidden' | 'listening' | 'analyzing' | 'responding'
  >('hidden')
  const [isOrbExiting, setIsOrbExiting] = useState(false)
  const [region, setRegion] = useState<Region | null>(null)
  const [isSelecting, setIsSelecting] = useState(false)
  const [isAutoListen, setIsAutoListen] = useState(false)
  const [isVoiceEnabled, setIsVoiceEnabled] = useState(true)
  const [isAskOpen, setIsAskOpen] = useState(false)
  const [askValue, setAskValue] = useState('')
  const [toolbar, setToolbar] = useState<ToolbarState>(readStoredToolbarState)
  const [isToolbarVisible, setIsToolbarVisible] = useState(false)
  const voiceOrbStateRef = useRef(voiceOrbState)
  const regionRef = useRef<Region | null>(null)
  const autoListenRef = useRef(false)
  const voiceEnabledRef = useRef(true)
  const toolbarRef = useRef<ToolbarState>(toolbar)
  const toolbarElementRef = useRef<HTMLElement | null>(null)
  const isToolbarVisibleRef = useRef(false)
  const isToolbarDraggingRef = useRef(false)
  const pointerRef = useRef({ x: 0, y: -1 })
  const interactiveRef = useRef(false)
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
      if (autoListenRef.current || !voiceEnabledRef.current) return
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
    if (!voiceEnabledRef.current) return
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
      if (voiceEnabledRef.current) {
        startAutoListen()
        setVoiceStatus('Auto-listening in selected area · Esc to stop')
      } else {
        setVoiceStatus('Area selected · type a question to analyze it')
      }
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
    // Without voice there is nothing to start/stop listening to, so the control
    // always (re)opens region selection for typed questions instead.
    if (!voiceEnabledRef.current) {
      startRegionSelection()
      return
    }
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

  const toggleDebugPanel = useCallback((): void => {
    window.api.overlay.setDebugVisible(!isDebugOpen)
  }, [isDebugOpen])

  const closeDebugPanel = useCallback((): void => {
    window.api.overlay.setDebugVisible(false)
  }, [])

  const toggleVoice = useCallback((): void => {
    const next = !voiceEnabledRef.current
    voiceEnabledRef.current = next
    setIsVoiceEnabled(next)

    if (!next) {
      // Tearing down the backend also ends any active or continuous session,
      // so reset the listener state locally instead of messaging a dying process.
      setIsAutoListen(false)
      autoListenRef.current = false
      voiceSessionActiveRef.current = false
      voiceSessionEndedRef.current = true
      clearVoiceInactivityTimer()
      hideOrbWithAnimation()
      setVoiceTranscript('')
      setVoiceStatus('Voice disabled')
    } else {
      setVoiceStatus('Starting voice listener...')
    }

    void window.api.voice.setEnabled(next).catch((error: unknown) => {
      // Roll the UI back so it always reflects the backend state.
      voiceEnabledRef.current = !next
      setIsVoiceEnabled(!next)
      setError(error instanceof Error ? error.message : 'Could not change voice activation')
    })
  }, [clearVoiceInactivityTimer, hideOrbWithAnimation])

  const openAskBar = useCallback((): void => {
    setIsAskOpen(true)
  }, [])

  const closeAskBar = useCallback((): void => {
    setIsAskOpen(false)
    setAskValue('')
  }, [])

  const handleToolbarMove = useCallback((edge: ToolbarEdge, position: number): void => {
    const next = { edge, position }
    toolbarRef.current = next
    setToolbar(next)
  }, [])

  const handleToolbarDraggingChange = useCallback((dragging: boolean): void => {
    isToolbarDraggingRef.current = dragging
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (isAskOpen) {
        closeAskBar()
        return
      }
      if (isSelecting) return
      clearRegion()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isAskOpen, closeAskBar, isSelecting, clearRegion])

  const audioContextRef = useRef<AudioContext | null>(null)
  const nextAudioTimeRef = useRef<number>(0)

  useEffect(() => window.api.overlay.onDebugVisibilityChanged(setIsDebugOpen), [])
  useEffect(() => {
    window.localStorage.setItem(TOOLBAR_STATE_STORAGE_KEY, JSON.stringify(toolbar))
  }, [toolbar])
  useEffect(() => {
    toolbarElementRef.current = document.querySelector('.toolbar')
  }, [])

  const isPointerNearToolbar = useCallback((x: number, y: number): boolean => {
    const element = toolbarElementRef.current
    if (!element) return false
    const width = element.offsetWidth
    const height = element.offsetHeight
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const { edge, position } = toolbarRef.current

    if (edge === 'top' || edge === 'bottom') {
      const center = (position / 100) * viewportWidth
      if (x < center - width / 2 || x > center + width / 2) return false
      return edge === 'top'
        ? y <= TOOLBAR_EDGE_INSET + height
        : y >= viewportHeight - TOOLBAR_EDGE_INSET - height
    }

    const center = (position / 100) * viewportHeight
    if (y < center - height / 2 || y > center + height / 2) return false
    return edge === 'left'
      ? x <= TOOLBAR_EDGE_INSET + width
      : x >= viewportWidth - TOOLBAR_EDGE_INSET - width
  }, [])

  // Single source of truth for overlay interactivity. The window stays
  // click-through, and we only make it interactive while the pointer is over a
  // surface the user can act on. Using a ref (not a local) keeps the mousemove
  // listener and the "surface appeared/disappeared" effect in sync.
  const setOverlayInteractive = useCallback((target: EventTarget | null): void => {
    const next =
      isToolbarDraggingRef.current ||
      Boolean(
        target instanceof Element &&
        target.closest('.toolbar, .indicator__copy-btn, .ask-bar, .debug-panel--open')
      )
    if (next === interactiveRef.current) return
    interactiveRef.current = next
    window.api.overlay.setInteractive(next)
  }, [])

  // Registered before the interactive listener so it updates the shared
  // pointer/visibility refs first whenever a mouse move fires.
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      if (isToolbarDraggingRef.current) return
      const nearToolbar = isPointerNearToolbar(event.clientX, event.clientY)
      const overToolbar =
        event.target instanceof Element && Boolean(event.target.closest('.toolbar'))
      const shouldBeVisible = nearToolbar || overToolbar
      if (shouldBeVisible !== isToolbarVisibleRef.current) {
        isToolbarVisibleRef.current = shouldBeVisible
        setIsToolbarVisible(shouldBeVisible)
      }
    }
    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [isPointerNearToolbar])
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      setOverlayInteractive(event.target)
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      if (interactiveRef.current) {
        interactiveRef.current = false
        window.api.overlay.setInteractive(false)
      }
    }
  }, [setOverlayInteractive])
  // A surface can appear or disappear under a stationary pointer (the toolbar
  // gets revealed, the panel opens/closes, the ask bar opens), in which case no
  // mousemove fires. Re-evaluate interactivity from the last known pointer.
  useEffect(() => {
    const { x, y } = pointerRef.current
    setOverlayInteractive(document.elementFromPoint(x, y))
  }, [isDebugOpen, isAskOpen, isToolbarVisible, isSelecting, setOverlayInteractive])
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
    void window.api.voice
      .getEnabled()
      .then((enabled) => {
        if (disposed) return
        voiceEnabledRef.current = enabled
        setIsVoiceEnabled(enabled)
        setVoiceStatus(enabled ? 'Starting voice listener...' : 'Voice disabled')
      })
      .catch(() => {
        // Defaults to enabled; live state still arrives through voice events.
      })
    return () => {
      disposed = true
    }
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
  useEffect(() => {
    let disposed = false
    void window.api.stt
      .getStatus()
      .then((status) => {
        if (!disposed) setSttStatus(status)
      })
      .catch(() => {
        // Status is informational; live updates arrive through onStatus below.
      })
    const unsubscribe = window.api.stt.onStatus((status) => setSttStatus(status))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    let disposed = false
    void window.api.tts
      .getStatus()
      .then((status) => {
        if (!disposed) setTtsStatus(status)
      })
      .catch(() => {
        // Status is informational; live updates arrive through onStatus below.
      })
    const unsubscribe = window.api.tts.onStatus((status) => setTtsStatus(status))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  useEffect(
    () =>
      window.api.voice.onEvent((event) => {
        if (!voiceEnabledRef.current) return
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

  const submitQuestion = useCallback(
    async (prompt: string): Promise<void> => {
      if (isLoadingRef.current) return

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
    },
    [setOrbState]
  )

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const prompt = question.trim()

    if (!prompt || isLoading) return

    await submitQuestion(prompt)
  }

  const submitAsk = useCallback((): void => {
    const prompt = askValue.trim()
    if (!prompt || isLoadingRef.current) return
    closeAskBar()
    void submitQuestion(prompt)
  }, [askValue, closeAskBar, submitQuestion])

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
      <Toolbar
        edge={toolbar.edge}
        position={toolbar.position}
        visible={isToolbarVisible}
        isPanelOpen={isDebugOpen}
        isSelecting={isSelecting}
        hasRegion={region !== null}
        isVoiceEnabled={isVoiceEnabled}
        isAsking={isAskOpen}
        onTogglePanel={toggleDebugPanel}
        onSelectArea={startRegionSelection}
        onToggleVoice={toggleVoice}
        onOpenAsk={openAskBar}
        onMove={handleToolbarMove}
        onDraggingChange={handleToolbarDraggingChange}
      />
      {isAskOpen && (
        <AskBar
          value={askValue}
          onChange={setAskValue}
          onSubmit={submitAsk}
          onClose={closeAskBar}
          disabled={isLoading}
        />
      )}
      <section
        className={`debug-panel${isDebugOpen ? ' debug-panel--open' : ''}`}
        aria-hidden={!isDebugOpen}
      >
        <div className="debug-panel__content">
          <h1 className="debug-panel__title">Settings Panel</h1>
          <div className="question-panel">
            <label className='keybind-label' htmlFor="screen-question">Ctrl+Shift+Space to toggle panel</label>
            <h2 className="question-panel__title">Installations</h2>
            {vlStatus || sttStatus || ttsStatus ? (
              <ul className="model-status">
                {vlStatus ? (
                  <>
                    <ModelStatusRow
                      label="llama.cpp runtime"
                      version={`build ${vlStatus.llamaVersion} · ${vlStatus.llamaBackend}`}
                      status={vlStatus.runtime}
                    />
                    <ModelStatusRow
                      label="Vision model"
                      version={`${vlStatus.modelAlias} · ${vlStatus.modelQuant}`}
                      status={vlStatus.model}
                    />
                    <ModelStatusRow
                      label="Vision projector"
                      version={`mmproj · ${vlStatus.mmprojQuant}`}
                      status={vlStatus.mmproj}
                    />
                    <ModelStatusRow
                      label="Inference server"
                      version={vlStatus.port ? `127.0.0.1:${vlStatus.port}` : 'Not running'}
                      status={vlStatus.server}
                    />
                  </>
                ) : null}
                {sttStatus ? (
                  <>
                    <ModelStatusRow
                      label="Wake word"
                      version="openwakeword · hey bud"
                      status={sttStatus.wakeWord}
                    />
                    <ModelStatusRow
                      label="Speech-to-text"
                      version="Moonshine small streaming · en"
                      status={sttStatus.transcription}
                    />
                  </>
                ) : null}
                {ttsStatus ? (
                  <ModelStatusRow
                    label="Text-to-speech"
                    version="Pocket-TTS · voice jane"
                    status={ttsStatus}
                  />
                ) : null}
              </ul>
            ) : (
              <p className="question-panel__voice-status">Checking components…</p>
            )}
          </div>

          <div className="question-panel">
            <h2 className="question-panel__title">Voice</h2>
            <label className="voice-toggle">
              <input type="checkbox" checked={isVoiceEnabled} onChange={toggleVoice} />
              <span>Enable voice activation (wake word &amp; speech-to-text)</span>
            </label>
            <p className="question-panel__voice-status">
              {isVoiceEnabled
                ? 'Wake word detection and speech-to-text are running.'
                : 'Voice is off · openwakeword and STT are stopped.'}
            </p>
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
                    ? !isVoiceEnabled
                      ? 'Reselect area'
                      : isAutoListen
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
        <button
          type="button"
          className="debug-panel__close"
          onClick={closeDebugPanel}
          aria-label="Close settings panel"
          title="Close settings panel"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
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
