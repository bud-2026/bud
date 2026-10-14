import { useEffect, useRef } from 'react'
import PromptPicker from './PromptPicker'
import './AskBar.css'

interface AskBarProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onClose: () => void
  disabled: boolean
  prompts: CustomPrompt[]
  activePromptId: string | null
  onSelectPrompt: (id: string) => void
}

function AskBar({
  value,
  onChange,
  onSubmit,
  onClose,
  disabled,
  prompts,
  activePromptId,
  onSelectPrompt
}: AskBarProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <form
      className="ask-bar"
      role="search"
      aria-label="Type a question"
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled || !value.trim()) return
        onSubmit()
      }}
    >
      <PromptPicker
        prompts={prompts}
        value={activePromptId}
        onChange={onSelectPrompt}
        disabled={disabled}
      />
      {activePromptId && <span className="ask-bar__divider" aria-hidden="true" />}
      <input
        ref={inputRef}
        className="ask-bar__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Ask about your screen or anything else…"
        disabled={disabled}
        aria-label="Your question"
      />
      <button type="submit" className="ask-bar__send" disabled={disabled || !value.trim()}>
        {disabled ? '…' : 'Ask'}
      </button>
      <button
        type="button"
        className="ask-bar__close"
        onClick={onClose}
        aria-label="Close"
        title="Close (Esc)"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
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
    </form>
  )
}

export default AskBar
