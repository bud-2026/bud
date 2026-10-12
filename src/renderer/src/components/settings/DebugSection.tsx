import type { FormEvent } from 'react'

interface DebugSectionProps {
  voiceStatus: string
  region: Region | null
  isAutoListen: boolean
  isSelecting: boolean
  isVoiceEnabled: boolean
  onRegionControlClick: () => void
  question: string
  onQuestionChange: (value: string) => void
  onAskSubmit: (event: FormEvent<HTMLFormElement>) => void
  isLoading: boolean
  result: ScreenAIResponse | null
  voiceTranscript: string
}

function DebugSection({
  voiceStatus,
  region,
  isAutoListen,
  isSelecting,
  isVoiceEnabled,
  onRegionControlClick,
  question,
  onQuestionChange,
  onAskSubmit,
  isLoading,
  result,
  voiceTranscript
}: DebugSectionProps): React.JSX.Element {
  return (
    <form className="question-panel" onSubmit={onAskSubmit}>
      <p className="question-panel__voice-status">{voiceStatus}</p>
      <div className="region-control">
        <button type="button" onClick={onRegionControlClick} disabled={isSelecting}>
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
          onChange={(event) => onQuestionChange(event.target.value)}
          placeholder="What is on my screen?"
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !question.trim()}>
          Ask
        </button>
      </div>
      {result && <p className="question-panel__response">{result.text}</p>}
      {voiceTranscript && <p className="question-panel__transcript">Heard: {voiceTranscript}</p>}
    </form>
  )
}

export default DebugSection
