import { useCallback, useEffect, useRef, useState } from 'react'
import './Toolbar.css'

export type ToolbarEdge = 'top' | 'bottom' | 'left' | 'right'

const EDGES: ToolbarEdge[] = ['top', 'bottom', 'left', 'right']

/** Pixels the pointer must get closer to another edge before the toolbar re-docks. */
const EDGE_SWITCH_MARGIN = 100

interface ToolbarProps {
  edge: ToolbarEdge
  /** Center position along the docked edge as a percentage. */
  position: number
  visible: boolean
  isPanelOpen: boolean
  isSelecting: boolean
  hasRegion: boolean
  onTogglePanel: () => void
  onSelectArea: () => void
  onMove: (edge: ToolbarEdge, position: number) => void
  onDraggingChange: (dragging: boolean) => void
}

function Toolbar({
  edge,
  position,
  visible,
  isPanelOpen,
  isSelecting,
  hasRegion,
  onTogglePanel,
  onSelectArea,
  onMove,
  onDraggingChange
}: ToolbarProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ edge: ToolbarEdge } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const clampPercent = useCallback((targetEdge: ToolbarEdge, percent: number): number => {
    const rect = containerRef.current?.getBoundingClientRect()
    const horizontal = targetEdge === 'top' || targetEdge === 'bottom'
    const extent = horizontal ? (rect?.width ?? 120) : (rect?.height ?? 120)
    const viewport = horizontal ? window.innerWidth : window.innerHeight
    const min = (extent / 2 / viewport) * 100
    return Math.min(100 - min, Math.max(min, percent))
  }, [])

  const handleGripDown = (event: React.MouseEvent): void => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = { edge }
    setIsDragging(true)
  }

  useEffect(() => {
    if (!isDragging) return
    window.api.overlay.setInteractive(true)
    onDraggingChange(true)

    const resolveDrag = (
      clientX: number,
      clientY: number
    ): { edge: ToolbarEdge; position: number } => {
      const width = window.innerWidth
      const height = window.innerHeight
      const distances: Record<ToolbarEdge, number> = {
        top: clientY,
        bottom: height - clientY,
        left: clientX,
        right: width - clientX
      }

      let nextEdge = dragRef.current?.edge ?? edge
      let bestDistance = distances[nextEdge]
      for (const candidate of EDGES) {
        if (candidate === nextEdge) continue
        if (distances[candidate] < bestDistance - EDGE_SWITCH_MARGIN) {
          bestDistance = distances[candidate]
          nextEdge = candidate
        }
      }

      const horizontal = nextEdge === 'top' || nextEdge === 'bottom'
      const percent = horizontal ? (clientX / width) * 100 : (clientY / height) * 100
      return { edge: nextEdge, position: clampPercent(nextEdge, percent) }
    }

    const handleMove = (event: MouseEvent): void => {
      const next = resolveDrag(event.clientX, event.clientY)
      if (dragRef.current) dragRef.current.edge = next.edge
      onMove(next.edge, next.position)
    }
    const handleUp = (): void => {
      dragRef.current = null
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      onDraggingChange(false)
    }
  }, [isDragging, edge, clampPercent, onDraggingChange, onMove])

  return (
    <div
      ref={containerRef}
      className={`toolbar toolbar--${edge}${visible ? ' toolbar--visible' : ''}${
        isDragging ? ' toolbar--dragging' : ''
      }`}
      style={{ '--toolbar-pos': `${position}%` } as React.CSSProperties}
      role="toolbar"
      aria-label="Bud controls"
      aria-hidden={!visible}
    >
      <button
        type="button"
        className="toolbar__grip"
        onMouseDown={handleGripDown}
        aria-label="Move toolbar along the screen edges"
        title="Drag to move along the edges"
      >
        <span className="toolbar__grip-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </button>
      <div className="toolbar__pill">
        <button
          type="button"
          className={`toolbar__btn${isPanelOpen ? ' toolbar__btn--active' : ''}`}
          onClick={onTogglePanel}
          aria-label="Open settings panel"
          aria-pressed={isPanelOpen}
          title="Settings panel (Ctrl+Shift+Space)"
        >
          <svg
            className="toolbar__icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          type="button"
          className={`toolbar__btn${isSelecting ? ' toolbar__btn--active' : ''}`}
          onClick={onSelectArea}
          aria-label="Select area to analyze"
          title="Select area to analyze"
        >
          <svg
            className="toolbar__icon"
            viewBox="0 0 24 24"
            width="20"
            height="20"
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
          {hasRegion && <span className="toolbar__badge" aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}

export default Toolbar
