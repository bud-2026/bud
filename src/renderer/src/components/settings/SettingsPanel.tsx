import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import SettingsCard from './SettingsCard'
import StatusSection from './StatusSection'
import VoiceSection from './VoiceSection'
import AiSection from './AiSection'
import DebugSection from './DebugSection'
import ApplicationSection from './ApplicationSection'
import { describeReadiness } from '../../lib/readiness'
import type { Readiness } from '../../lib/readiness'
import './SettingsPanel.css'

type SettingsSection = 'status' | 'voice' | 'ai' | 'debug' | 'application'

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  readiness: Readiness
  vlStatus: VlStatusSnapshot | null
  sttStatus: SttStatusSnapshot | null
  ttsStatus: BackendComponentStatus | null
  isVoiceEnabled: boolean
  onToggleVoice: () => void
  voiceStatus: string
  question: string
  onQuestionChange: (value: string) => void
  onAskSubmit: (event: FormEvent<HTMLFormElement>) => void
  isLoading: boolean
  result: ScreenAIResponse | null
  voiceTranscript: string
  region: Region | null
  isAutoListen: boolean
  isSelecting: boolean
  onRegionControlClick: () => void
  onClearRegion: () => void
  error: string | null
  onError: (message: string | null) => void
  onQuit: () => void
}

const SECTION_LABELS: Record<SettingsSection, string> = {
  status: 'Status',
  voice: 'Voice',
  ai: 'AI',
  debug: 'Debug',
  application: 'Application'
}

interface SettingsCardConfig {
  section: SettingsSection
  title: string
  description: string
  icon: React.JSX.Element
  /** Which readiness signal gates this card. */
  requires: 'none' | 'global'
}

const CARDS: SettingsCardConfig[] = [
  {
    section: 'status',
    title: 'Status',
    description: 'Component and model installation status',
    requires: 'none',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 12h4l3 8 4-16 3 8h4" />
      </svg>
    )
  },
  {
    section: 'voice',
    title: 'Voice',
    description: 'Voice activation and text-to-speech',
    requires: 'global',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    )
  },
  {
    section: 'ai',
    title: 'AI',
    description: 'Base URL, API key, and model ID',
    requires: 'none',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
      </svg>
    )
  },
  {
    section: 'debug',
    title: 'Debug',
    description: 'Area selection, screen questions, and responses',
    requires: 'global',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="4 3" />
        <line x1="9" y1="12" x2="15" y2="12" />
        <line x1="12" y1="9" x2="12" y2="15" />
      </svg>
    )
  },
  {
    section: 'application',
    title: 'Application',
    description: 'Quit Bud',
    requires: 'none',
    icon: (
      <svg
        viewBox="0 0 24 24"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2v10" />
        <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
      </svg>
    )
  }
]

function SettingsPanel({
  open,
  onClose,
  readiness,
  vlStatus,
  sttStatus,
  ttsStatus,
  isVoiceEnabled,
  onToggleVoice,
  voiceStatus,
  question,
  onQuestionChange,
  onAskSubmit,
  isLoading,
  result,
  voiceTranscript,
  region,
  isAutoListen,
  isSelecting,
  onRegionControlClick,
  onClearRegion,
  error,
  onError,
  onQuit
}: SettingsPanelProps): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection | null>(null)

  const handleClose = useCallback((): void => {
    setSection(null)
    onClose()
  }, [onClose])

  // Escape returns to the landing grid when a section is open. Captured so it
  // takes precedence over the overlay's own Escape handling.
  useEffect(() => {
    if (!open || section === null) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setSection(null)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [open, section])

  const renderSection = (): React.JSX.Element => {
    switch (section) {
      case 'status':
        return (
          <StatusSection
            readiness={readiness}
            vlStatus={vlStatus}
            sttStatus={sttStatus}
            ttsStatus={ttsStatus}
          />
        )
      case 'voice':
        return (
          <VoiceSection
            isVoiceEnabled={isVoiceEnabled}
            onToggleVoice={onToggleVoice}
            onError={onError}
          />
        )
      case 'ai':
        return <AiSection onError={onError} />
      case 'debug':
        return (
          <DebugSection
            voiceStatus={voiceStatus}
            region={region}
            isAutoListen={isAutoListen}
            isSelecting={isSelecting}
            isVoiceEnabled={isVoiceEnabled}
            onRegionControlClick={onRegionControlClick}
            onClearRegion={onClearRegion}
            question={question}
            onQuestionChange={onQuestionChange}
            onAskSubmit={onAskSubmit}
            isLoading={isLoading}
            result={result}
            voiceTranscript={voiceTranscript}
          />
        )
      case 'application':
        return <ApplicationSection onQuit={onQuit} />
      case null:
        return <></>
    }
  }

  return (
    <section className={`debug-panel${open ? ' debug-panel--open' : ''}`} aria-hidden={!open}>
      <div className="debug-panel__content">
        <header className="settings-header">
          <div className="settings-header__top">
            {section !== null ? (
              <button
                type="button"
                className="settings-header__back"
                onClick={() => setSection(null)}
                aria-label="Back to settings"
                title="Back"
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
                  <line x1="19" y1="12" x2="5" y2="12" />
                  <polyline points="12 19 5 12 12 5" />
                </svg>
              </button>
            ) : null}
            <h1 className="debug-panel__title">
              {section === null ? 'Settings' : SECTION_LABELS[section]}
            </h1>
          </div>
          <span className="keybind-label">Ctrl+Shift+Space to toggle panel</span>
        </header>

        {section === null ? (
          <nav className="settings-grid" aria-label="Settings sections">
            {CARDS.map((card) => {
              // The Voice card stays reachable while voice is on so a failed
              // voice backend can still be turned off again.
              const gated =
                card.requires === 'global' &&
                !readiness.ready &&
                !(card.section === 'voice' && isVoiceEnabled)
              // The Status card always surfaces the aggregate readiness so it is
              // visible without opening the section; gated cards show why they
              // are unavailable.
              const showStatus = card.section === 'status' || gated
              const summary = showStatus ? describeReadiness(readiness.level) : null
              return (
                <SettingsCard
                  key={card.section}
                  icon={card.icon}
                  title={card.title}
                  description={card.description}
                  onClick={() => setSection(card.section)}
                  disabled={gated}
                  status={summary?.label}
                  statusTone={summary?.tone}
                />
              )
            })}
          </nav>
        ) : (
          renderSection()
        )}

        {error && <p className="question-panel__error">{error}</p>}
      </div>
      <button
        type="button"
        className="debug-panel__close"
        onClick={handleClose}
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
  )
}

export default SettingsPanel
