import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AskBar from './components/AskBar'
import Indicator from './components/Indicator'
import RegionSelector from './components/RegionSelector'
import Toolbar, { type ToolbarEdge } from './components/Toolbar'
import VoiceOrb from './components/VoiceOrb'
import WelcomeGuide from './components/WelcomeGuide'
import SettingsPanel from './components/settings/SettingsPanel'
import { askQuestion } from './lib/ai'
import { computeReadiness } from './lib/readiness'

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

function App(): React.JSX.Element {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<ScreenAIResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
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
  const [isGuideOpen, setIsGuideOpen] = useState(false)
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

  // Single source of truth for "is Bud usable". Drives the Status panel banner,
  // gating of the Voice/Debug cards, and the toolbar buttons.
  const readiness = useMemo(
    () => computeReadiness(vlStatus, sttStatus, ttsStatus, isVoiceEnabled),
    [vlStatus, sttStatus, ttsStatus, isVoiceEnabled]
  )

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
        // With voice off there is nothing to listen for, so surface the ask bar
        // so the user can immediately type a question about the selected area.
        setIsAskOpen(true)
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

  const setDebugPanelVisible = useCallback((visible: boolean): void => {
    window.api.overlay.setDebugVisible(visible)
  }, [])

  const openGuide = useCallback((): void => {
    setIsGuideOpen(true)
  }, [])

  // Finishing or skipping both mark the guide as seen so it only auto-opens on
  // the very first launch. The settings panel's "?" button can still bring it
  // back at any time.
  const closeGuide = useCallback((): void => {
    setIsGuideOpen(false)
    void window.api.guide.setSeen(true).catch(() => {
      // Persisting the flag is not critical to closing the guide.
    })
  }, [])

  const quitApp = useCallback((): void => {
    void window.api.app.quit()
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
  // Open the getting-started guide automatically the first time Bud runs. The
  // boolean lives in the settings file and is set once the guide is dismissed.
  useEffect(() => {
    let disposed = false
    void window.api.guide
      .getSeen()
      .then((seen) => {
        if (!disposed && !seen) setIsGuideOpen(true)
      })
      .catch(() => {
        // The guide is optional; ignore read failures.
      })
    return () => {
      disposed = true
    }
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
        target.closest(
          '.toolbar, .indicator__copy-btn, .ask-bar, .debug-panel--open, .region-clear, .welcome-guide'
        )
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
    // The guide covers the whole screen and must be clickable even before the
    // pointer has moved (it auto-opens on first launch), so force interactivity
    // while it is open instead of relying on hover tracking.
    if (isGuideOpen) {
      if (!interactiveRef.current) {
        interactiveRef.current = true
        window.api.overlay.setInteractive(true)
      }
      return
    }
    const { x, y } = pointerRef.current
    setOverlayInteractive(document.elementFromPoint(x, y))
  }, [isDebugOpen, isAskOpen, isToolbarVisible, isSelecting, isGuideOpen, setOverlayInteractive])
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
        >
          <button
            type="button"
            className="region-clear"
            onClick={clearRegion}
            aria-label="Clear selected area"
            title="Clear selected area"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
      )}
      <Toolbar
        edge={toolbar.edge}
        position={toolbar.position}
        visible={isToolbarVisible || isGuideOpen}
        isPanelOpen={isDebugOpen}
        isSelecting={isSelecting}
        hasRegion={region !== null}
        isVoiceEnabled={isVoiceEnabled}
        isAsking={isAskOpen}
        ready={readiness.ready}
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
      <SettingsPanel
        open={isDebugOpen}
        onClose={closeDebugPanel}
        readiness={readiness}
        vlStatus={vlStatus}
        sttStatus={sttStatus}
        ttsStatus={ttsStatus}
        isVoiceEnabled={isVoiceEnabled}
        onToggleVoice={toggleVoice}
        voiceStatus={voiceStatus}
        question={question}
        onQuestionChange={setQuestion}
        onAskSubmit={handleSubmit}
        isLoading={isLoading}
        result={result}
        voiceTranscript={voiceTranscript}
        region={region}
        isAutoListen={isAutoListen}
        isSelecting={isSelecting}
        onRegionControlClick={handleRegionControlClick}
        onClearRegion={clearRegion}
        error={error}
        onError={setError}
        onQuit={quitApp}
        onOpenGuide={openGuide}
      />
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
      {isGuideOpen && <WelcomeGuide onClose={closeGuide} onRequestPanel={setDebugPanelVisible} />}
    </main>
  )
}

export default App
