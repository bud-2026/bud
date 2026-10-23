import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AskBar from './components/AskBar'
import Indicator from './components/Indicator'
import RegionSelector from './components/RegionSelector'
import Toolbar, { type ToolbarEdge } from './components/Toolbar'
import VoiceOrb from './components/VoiceOrb'
import AnswerCaption from './components/AnswerCaption'
import WelcomeGuide from './components/WelcomeGuide'
import SettingsPanel from './components/settings/SettingsPanel'
import { askQuestion } from './lib/ai'
import { computeReadiness } from './lib/readiness'

const VOICE_HISTORY_MESSAGE_LIMIT = 20
const TOOLBAR_EDGE_INSET = 8
const TOOLBAR_STATE_STORAGE_KEY = 'bud-toolbar-state'
const TOOLBAR_LEGACY_X_STORAGE_KEY = 'bud-toolbar-x'
// Scheduling the first chunk slightly in the future absorbs IPC/scheduling
// jitter instead of starting mid-buffer and clicking.
const AUDIO_LEAD_IN_SECONDS = 0.15

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

// Toolbar placement is remembered per display, so docking it on one screen does
// not move it on the others. Until the display id is known the unscoped legacy
// key is used as a fallback.
function toolbarStorageKey(displayId: number | null): string {
  return displayId === null
    ? TOOLBAR_STATE_STORAGE_KEY
    : `${TOOLBAR_STATE_STORAGE_KEY}-${displayId}`
}

function readStoredToolbarState(displayId: number | null = null): ToolbarState {
  try {
    let raw = window.localStorage.getItem(toolbarStorageKey(displayId))
    if (!raw && displayId !== null) {
      raw = window.localStorage.getItem(TOOLBAR_STATE_STORAGE_KEY)
    }
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
  const [captionText, setCaptionText] = useState('')
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
  const [isWriteAnswers, setIsWriteAnswers] = useState(false)
  const [isAskOpen, setIsAskOpen] = useState(false)
  const [askValue, setAskValue] = useState('')
  const [toolbar, setToolbar] = useState<ToolbarState>(readStoredToolbarState)
  const [displayInfo, setDisplayInfo] = useState<{
    displayId: number
    isPrimary: boolean
  } | null>(null)
  const [isToolbarVisible, setIsToolbarVisible] = useState(false)
  const [isGuideOpen, setIsGuideOpen] = useState(false)
  const voiceOrbStateRef = useRef(voiceOrbState)
  const regionRef = useRef<Region | null>(null)
  const autoListenRef = useRef(false)
  const voiceEnabledRef = useRef(true)
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

  // Owns the "write answers" setting so the settings toggle updates the live
  // overlay caption immediately, rather than only after a restart.
  const handleToggleWriteAnswers = useCallback((next: boolean): void => {
    setError(null)
    setIsWriteAnswers(next)
    void window.api.answers
      .setWrite(next)
      .then((saved) => setIsWriteAnswers(saved))
      .catch((error: unknown) => {
        setIsWriteAnswers(!next)
        setError(
          error instanceof Error ? error.message : 'Could not save the answer display setting'
        )
      })
  }, [])

  const openAskBar = useCallback((): void => {
    setIsAskOpen(true)
  }, [])

  const closeAskBar = useCallback((): void => {
    setIsAskOpen(false)
    setAskValue('')
  }, [])

  const handleToolbarMove = useCallback((edge: ToolbarEdge, position: number): void => {
    const next = { edge, position }
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
  const activeTtsRequestIdRef = useRef<string | null>(null)
  const ttsSampleRateRef = useRef<number>(0)
  const activeTtsSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set())

  useEffect(() => window.api.overlay.onDebugVisibilityChanged(setIsDebugOpen), [])
  useEffect(() => {
    if (!displayInfo) return
    window.localStorage.setItem(toolbarStorageKey(displayInfo.displayId), JSON.stringify(toolbar))
  }, [toolbar, displayInfo])
  useEffect(() => {
    toolbarElementRef.current = document.querySelector('.toolbar')
  }, [])
  // Read this overlay's display identity once. It gates app-wide surfaces (the
  // guide and settings panel live on a single display) and namespaces the
  // per-display toolbar placement. The getting-started guide auto-opens only on
  // the primary display, the first time Bud runs.
  useEffect(() => {
    let disposed = false
    void Promise.all([window.api.guide.getSeen(), window.api.overlay.getInfo()])
      .then(([seen, info]) => {
        if (disposed) return
        setDisplayInfo(info)
        setToolbar(readStoredToolbarState(info.displayId))
        if (!seen && info.isPrimary) setIsGuideOpen(true)
      })
      .catch(() => {
        // The guide and display info are optional; ignore read failures.
      })
    return () => {
      disposed = true
    }
  }, [])

  const isPointerNearToolbar = useCallback((x: number, y: number): boolean => {
    const element = toolbarElementRef.current
    if (!element) return false
    const { edge } = toolbar
    const rect = element.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    // Along the docked edge the element's center is stable: it is anchored at
    // position% and shifted by -50%, so its own rect is the source of truth and
    // no separate position tracking is needed.
    if (edge === 'top' || edge === 'bottom') {
      if (x < rect.left || x > rect.right) return false
      return edge === 'top'
        ? y <= TOOLBAR_EDGE_INSET + rect.height
        : y >= viewportHeight - TOOLBAR_EDGE_INSET - rect.height
    }

    if (y < rect.top || y > rect.bottom) return false
    return edge === 'left'
      ? x <= TOOLBAR_EDGE_INSET + rect.width
      : x >= viewportWidth - TOOLBAR_EDGE_INSET - rect.width
  }, [toolbar.edge])

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
  // Whether Bud also writes its spoken answer out on screen. Read once on mount;
  // the settings panel persists changes for the next launch.
  useEffect(() => {
    let disposed = false
    void window.api.answers
      .getWrite()
      .then((enabled) => {
        if (!disposed) setIsWriteAnswers(enabled)
      })
      .catch(() => {
        // Defaults to off; the feature is purely presentational.
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
    const stopScheduledAudio = (): void => {
      for (const source of activeTtsSourcesRef.current) {
        try {
          source.stop()
        } catch {
          // Already stopped or never started.
        }
        source.disconnect()
      }
      activeTtsSourcesRef.current.clear()
    }

    const unsubscribeStart = window.api.tts.onStart(({ requestId, sampleRate, text }) => {
      stopScheduledAudio()
      activeTtsRequestIdRef.current = requestId
      ttsSampleRateRef.current = sampleRate
      if (orbHideTimerRef.current) clearTimeout(orbHideTimerRef.current)
      clearVoiceInactivityTimer()
      setCaptionText(text)
      setOrbState('responding')
      isSpeakingRef.current = true

      let context = audioContextRef.current
      if (!context || context.state === 'closed') {
        try {
          context = new AudioContext({ sampleRate })
        } catch {
          context = new AudioContext()
        }
        audioContextRef.current = context
      }
      if (context.state === 'suspended') void context.resume()
      nextAudioTimeRef.current = context.currentTime + AUDIO_LEAD_IN_SECONDS
    })
    const unsubscribeChunk = window.api.tts.onChunk(({ requestId, chunk }) => {
      if (requestId !== activeTtsRequestIdRef.current) return
      const context = audioContextRef.current
      if (!context) return

      const bytes =
        chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
          ? chunk
          : chunk.slice()
      const sampleCount = Math.floor(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT)
      if (sampleCount === 0) return

      const samples = new Float32Array(sampleCount)
      samples.set(new Float32Array(bytes.buffer, 0, sampleCount))
      const audioBuffer = context.createBuffer(
        1,
        sampleCount,
        ttsSampleRateRef.current || context.sampleRate
      )
      audioBuffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = audioBuffer
      source.connect(context.destination)
      source.addEventListener('ended', () => {
        activeTtsSourcesRef.current.delete(source)
        source.disconnect()
      })
      activeTtsSourcesRef.current.add(source)
      const startTime = Math.max(context.currentTime, nextAudioTimeRef.current)
      source.start(startTime)
      nextAudioTimeRef.current = startTime + audioBuffer.duration
    })
    const unsubscribeEnd = window.api.tts.onEnd((requestId) => {
      if (requestId !== activeTtsRequestIdRef.current) return
      activeTtsRequestIdRef.current = null

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
      activeTtsRequestIdRef.current = null
      stopScheduledAudio()
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
      stopScheduledAudio()
      if (orbHideTimerRef.current) clearTimeout(orbHideTimerRef.current)
      if (voiceInactivityTimerRef.current) clearTimeout(voiceInactivityTimerRef.current)
      if (boxesClearTimerRef.current) clearTimeout(boxesClearTimerRef.current)
      void audioContextRef.current?.close()
      audioContextRef.current = null
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
      {/* <VoiceOrb state="responding" /> */}
      {voiceOrbState !== 'hidden' && <VoiceOrb state={voiceOrbState} exiting={isOrbExiting} />}
      {isWriteAnswers && captionText && voiceOrbState === 'responding' && (
        <AnswerCaption text={captionText} exiting={isOrbExiting} />
      )}
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
        isWriteAnswers={isWriteAnswers}
        onToggleWriteAnswers={handleToggleWriteAnswers}
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
