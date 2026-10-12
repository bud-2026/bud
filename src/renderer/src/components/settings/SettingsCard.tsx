import type { ReactNode } from 'react'
import type { ReadinessTone } from '../../lib/readiness'

interface SettingsCardProps {
  icon: ReactNode
  title: string
  description: string
  onClick: () => void
  disabled?: boolean
  status?: string
  statusTone?: ReadinessTone
}

function SettingsCard({
  icon,
  title,
  description,
  onClick,
  disabled = false,
  status,
  statusTone = 'pending'
}: SettingsCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`settings-card${disabled ? ' settings-card--disabled' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="settings-card__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="settings-card__body">
        <span className="settings-card__title">{title}</span>
        <span className="settings-card__desc">{description}</span>
      </span>
      {status ? (
        <span className={`settings-card__status settings-card__status--${statusTone}`}>
          {status}
        </span>
      ) : null}
    </button>
  )
}

export default SettingsCard
