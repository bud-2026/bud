import type { ReactNode } from 'react'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  disabled?: boolean
}

// Shared switch used across every settings section so the toggle geometry,
// label styling, and states stay identical.
function Toggle({ checked, onChange, label, disabled = false }: ToggleProps): React.JSX.Element {
  return (
    <label className="settings-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span className="settings-toggle__label">{label}</span>
    </label>
  )
}

export default Toggle
