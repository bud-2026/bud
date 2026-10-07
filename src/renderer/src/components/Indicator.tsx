import './Indicator.css'

export interface Point {
  /** Coordinate on the 1000x1000 viewport grid, from 0 to 1000. */
  x: number
  /** Coordinate on the 1000x1000 viewport grid, from 0 to 1000. */
  y: number
}

export interface IndicatorProps {
  topLeft: Point
  bottomRight: Point
  label?: string
  /** Extra padding around the box, in 1000x1000 grid units. */
  padding?: number
}

function Indicator({
  topLeft,
  bottomRight,
  label = 'Person',
  padding = 5
}: IndicatorProps): React.JSX.Element {
  const left = Math.min(1000, Math.max(0, topLeft.x - padding)) / 10
  const top = Math.min(1000, Math.max(0, topLeft.y - padding)) / 10
  const right = Math.min(1000, Math.max(topLeft.x, bottomRight.x + padding)) / 10
  const bottom = Math.min(1000, Math.max(topLeft.y, bottomRight.y + padding)) / 10

  return (
    <div
      className="indicator"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${right - left}%`,
        height: `${bottom - top}%`
      }}
      aria-label={`${label} detected`}
    >
      <span className="indicator__pulse" />
      <span className="indicator__label">{label}</span>
    </div>
  )
}

export default Indicator
