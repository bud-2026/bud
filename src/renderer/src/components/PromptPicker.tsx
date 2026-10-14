import './PromptPicker.css'

interface PromptPickerProps {
  prompts: CustomPrompt[]
  value: string | null
  onChange: (id: string) => void
  disabled?: boolean
  /** 'bar' sits inside the floating ask bar; 'panel' inside the settings panel. */
  variant?: 'bar' | 'panel'
}

// Dropdown shared by the ask bar and the debug panel so the active custom
// prompt is chosen the same way everywhere.
function PromptPicker({
  prompts,
  value,
  onChange,
  disabled = false,
  variant = 'bar'
}: PromptPickerProps): React.JSX.Element {
  return (
    <select
      className={`prompt-picker prompt-picker--${variant}`}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled || prompts.length === 0}
      aria-label="Custom prompt"
      title={prompts.length === 0 ? 'No custom prompts yet' : 'Select a custom prompt'}
    >
      <option value="">Default</option>
      {prompts.map((prompt) => (
        <option key={prompt.id} value={prompt.id}>
          {prompt.name}
        </option>
      ))}
    </select>
  )
}

export default PromptPicker
