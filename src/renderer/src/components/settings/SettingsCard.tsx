import type { ReactNode } from 'react'

interface SettingsCardProps {
  icon: ReactNode
  title: string
  description: string
  onClick: () => void
}

function SettingsCard({ icon, title, description, onClick }: SettingsCardProps): React.JSX.Element {
  return (
    <button type="button" className="settings-card" onClick={onClick}>
      <span className="settings-card__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="settings-card__body">
        <span className="settings-card__title">{title}</span>
        <span className="settings-card__desc">{description}</span>
      </span>
    </button>
  )
}

export default SettingsCard
