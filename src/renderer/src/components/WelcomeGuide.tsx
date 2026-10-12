import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './WelcomeGuide.css'

interface WelcomeGuideProps {
  /** Called when the user finishes or skips; persists that the guide was seen. */
  onClose: () => void
  /** Lets the tour open/close the settings panel so steps can target it. */
  onRequestPanel: (open: boolean) => void
}

type GuidePlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right'

interface GuideStep {
  id: string
  title: string
  body: string
  /** CSS selector for the element to spotlight, or null for a centered card. */
  target: string | null
  placement: GuidePlacement
  /** How the guide should treat the settings panel while this step is active. */
  panel: 'open' | 'closed' | 'keep'
}

// The toolbar docks to any edge and its buttons live at different screen
// positions, so every step targets a live DOM node by attribute and the
// spotlight follows its measured bounding rect.
const STEPS: GuideStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Bud',
    body: 'Bud is a voice-enabled assistant with screen vision. Say “Hey Bud” or type a question, and Bud reads, explains, and points at what is on your screen.',
    target: null,
    placement: 'auto',
    panel: 'keep'
  },
  {
    id: 'toolbar',
    title: 'The Bud toolbar',
    body: 'This is the toolbar. It hides against the edge of your screen and slides out when you move your cursor near it. It can dock to any edge.',
    target: '.toolbar',
    placement: 'auto',
    panel: 'closed'
  },
  {
    id: 'grip',
    title: 'Reposition the toolbar',
    body: 'Drag the dots to move the toolbar. Drop it near any edge and it re-docks there, so it stays out of your way.',
    target: '[data-tour="grip"]',
    placement: 'auto',
    panel: 'keep'
  },
  {
    id: 'settings-btn',
    title: 'Settings',
    body: 'Open the Settings panel to configure Bud. Shortcut: Ctrl+Shift+Space.',
    target: '[data-tour="settings"]',
    placement: 'auto',
    panel: 'keep'
  },
  {
    id: 'select-btn',
    title: 'Select an area',
    body: 'Focus Bud on part of your screen. Drag a box over anything, then ask about it. A green dot means an area is active.',
    target: '[data-tour="select"]',
    placement: 'auto',
    panel: 'keep'
  },
  {
    id: 'voice-btn',
    title: 'Voice activation',
    body: 'Toggle voice on or off. When it is on, Bud listens for the wake word and answers out loud.',
    target: '[data-tour="voice"]',
    placement: 'auto',
    panel: 'keep'
  },
  {
    id: 'ask-btn',
    title: 'Ask by typing',
    body: 'Prefer typing? Open the Ask bar to type a question about your screen or anything else.',
    target: '[data-tour="ask"]',
    placement: 'auto',
    panel: 'keep'
  },
  {
    id: 'settings-panel',
    title: 'The Settings panel',
    body: 'Everything lives here: Status (components and models), Voice, AI (base URL, key, and model), Debug (area selection and typed questions), and Application (quit Bud).',
    target: '.debug-panel',
    placement: 'auto',
    panel: 'open'
  },
  {
    id: 'done',
    title: 'You are all set!',
    body: 'Hover the edge of your screen to reveal the toolbar, then click the gear any time for settings. Reopen this guide with the “?” button in Settings.',
    target: null,
    placement: 'auto',
    panel: 'keep'
  }
]

const SPOTLIGHT_PADDING = 8
const CARD_GAP = 16
const CARD_WIDTH = 360

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

function measure(selector: string): Rect | null {
  const element = document.querySelector(selector)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function WelcomeGuide({ onClose, onRequestPanel }: WelcomeGuideProps): React.JSX.Element {
  const [stepIndex, setStepIndex] = useState(0)
  const [targetRect, setTargetRect] = useState<Rect | null>(null)
  const nextButtonRef = useRef<HTMLButtonElement | null>(null)

  const step = STEPS[stepIndex]
  const isFirst = stepIndex === 0
  const isLast = stepIndex === STEPS.length - 1
  // Only trust the measured rect while the current step actually has a target.
  const activeRect = step.target ? targetRect : null

  // Keep the settings panel in sync with the active step.
  useEffect(() => {
    if (step.panel === 'open') onRequestPanel(true)
    else if (step.panel === 'closed') onRequestPanel(false)
  }, [step, onRequestPanel])

  // Continuously measure the spotlight target. A loop (rather than one-shot)
  // lets the box track the settings panel as it slides in and follows the
  // toolbar wherever it happens to be docked.
  useLayoutEffect(() => {
    if (!step.target) return

    const selector = step.target
    let frame = 0
    let last: Rect | null = null
    const tick = (): void => {
      const rect = measure(selector)
      if (
        rect &&
        (!last ||
          last.left !== rect.left ||
          last.top !== rect.top ||
          last.width !== rect.width ||
          last.height !== rect.height)
      ) {
        last = rect
        setTargetRect(rect)
      }
      frame = requestAnimationFrame(tick)
    }
    tick()

    return () => cancelAnimationFrame(frame)
  }, [step])

  useEffect(() => {
    nextButtonRef.current?.focus()
  }, [stepIndex])

  const handleBack = useCallback((): void => {
    setStepIndex((current) => Math.max(0, current - 1))
  }, [])

  const handleNext = useCallback((): void => {
    if (stepIndex >= STEPS.length - 1) {
      onClose()
      return
    }
    setStepIndex(stepIndex + 1)
  }, [stepIndex, onClose])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault()
        handleNext()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        handleBack()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [onClose, handleNext, handleBack])

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const cardWidth = Math.min(CARD_WIDTH, viewportWidth - 32)

  const resolvePlacement = (): Exclude<GuidePlacement, 'auto'> => {
    if (!activeRect) return 'bottom'
    if (step.placement !== 'auto') return step.placement
    const spaceBelow = viewportHeight - (activeRect.top + activeRect.height)
    const spaceAbove = activeRect.top
    const spaceRight = viewportWidth - (activeRect.left + activeRect.width)
    const spaceLeft = activeRect.left
    const best = Math.max(spaceBelow, spaceAbove, spaceRight, spaceLeft)
    if (best === spaceBelow) return 'bottom'
    if (best === spaceAbove) return 'top'
    if (best === spaceRight) return 'right'
    return 'left'
  }

  const cardStyle = ((): React.CSSProperties => {
    if (!activeRect) {
      return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
    }

    const placement = resolvePlacement()
    const centerX = activeRect.left + activeRect.width / 2
    const centerY = activeRect.top + activeRect.height / 2
    const horizontalMargin = cardWidth / 2 + 16
    const verticalMargin = 120

    switch (placement) {
      case 'top':
        return {
          left: clamp(centerX, horizontalMargin, viewportWidth - horizontalMargin),
          top: activeRect.top - CARD_GAP,
          transform: 'translate(-50%, -100%)'
        }
      case 'bottom':
        return {
          left: clamp(centerX, horizontalMargin, viewportWidth - horizontalMargin),
          top: activeRect.top + activeRect.height + CARD_GAP,
          transform: 'translate(-50%, 0)'
        }
      case 'left':
        return {
          left: Math.max(activeRect.left - CARD_GAP, cardWidth + 16),
          top: clamp(centerY, verticalMargin, viewportHeight - verticalMargin),
          transform: 'translate(-100%, -50%)'
        }
      case 'right':
        return {
          left: Math.min(
            activeRect.left + activeRect.width + CARD_GAP,
            viewportWidth - cardWidth - 16
          ),
          top: clamp(centerY, verticalMargin, viewportHeight - verticalMargin),
          transform: 'translate(0, -50%)'
        }
    }
  })()

  // Clamp the spotlight to the viewport: the settings panel sits flush against
  // the screen edges, so padding it outward would push the border off-screen.
  const spotlightStyle: React.CSSProperties | null = activeRect
    ? (() => {
        const left = Math.max(0, activeRect.left - SPOTLIGHT_PADDING)
        const top = Math.max(0, activeRect.top - SPOTLIGHT_PADDING)
        const right = Math.min(
          viewportWidth,
          activeRect.left + activeRect.width + SPOTLIGHT_PADDING
        )
        const bottom = Math.min(
          viewportHeight,
          activeRect.top + activeRect.height + SPOTLIGHT_PADDING
        )
        return { left, top, width: right - left, height: bottom - top }
      })()
    : null

  return (
    <div
      className="welcome-guide"
      role="dialog"
      aria-modal="true"
      aria-label="Getting started guide"
    >
      {spotlightStyle ? (
        <div className="welcome-guide__spotlight" style={spotlightStyle} aria-hidden="true" />
      ) : (
        <div className="welcome-guide__backdrop" aria-hidden="true" />
      )}

      <div className="welcome-guide__card" style={cardStyle}>
        <span className="welcome-guide__progress">
          Step {stepIndex + 1} of {STEPS.length}
        </span>
        <h2 className="welcome-guide__title">{step.title}</h2>
        <p className="welcome-guide__body">{step.body}</p>

        <div className="welcome-guide__dots" aria-hidden="true">
          {STEPS.map((entry, index) => (
            <span
              key={entry.id}
              className={`welcome-guide__dot${
                index === stepIndex ? ' welcome-guide__dot--active' : ''
              }`}
            />
          ))}
        </div>

        <div className="welcome-guide__actions">
          <button type="button" className="welcome-guide__skip" onClick={onClose}>
            Skip
          </button>
          <div className="welcome-guide__nav">
            <button
              type="button"
              className="welcome-guide__back"
              onClick={handleBack}
              disabled={isFirst}
            >
              Back
            </button>
            <button
              ref={nextButtonRef}
              type="button"
              className="welcome-guide__next"
              onClick={handleNext}
            >
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default WelcomeGuide
