import { useRef, useState } from 'react'

import styles from './column-resizer.module.scss'

interface ColumnResizerProps {
  /** right：手柄贴在列右缘（左栏）；left：手柄贴在列左缘（批注栏） */
  side: 'left' | 'right'
  value: number
  min: number
  max: number
  label: string
  onChange: (value: number) => void
  /** 松开或键盘调整后触发，用于持久化 */
  onCommit: (value: number) => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 列宽拖拽手柄：拖动时实时改 store，松手才写偏好。
 * 键盘 ←/→ 也能微调（每次 12px），方便不用鼠标的场景。
 */
export function ColumnResizer({
  side,
  value,
  min,
  max,
  label,
  onChange,
  onCommit
}: ColumnResizerProps): React.JSX.Element {
  const [active, setActive] = useState(false)
  const dragging = useRef(false)
  const start = useRef({ x: 0, value })
  const latest = useRef(value)
  latest.current = value

  const finish = (): void => {
    dragging.current = false
    setActive(false)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    onCommit(latest.current)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-side={side}
      data-active={active}
      className={styles.handle}
      title={label}
      onPointerDown={(event) => {
        event.preventDefault()
        dragging.current = true
        start.current = {
          x: event.clientX,
          value: latest.current
        }
        setActive(true)
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return
        const delta = event.clientX - start.current.x
        const next = clamp(
          side === 'right' ? start.current.value + delta : start.current.value - delta,
          min,
          max
        )
        latest.current = next
        onChange(next)
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        finish()
      }}
      onPointerCancel={() => {
        if (!dragging.current) return
        finish()
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 12
        let next: number | null = null
        if (event.key === 'ArrowLeft') next = latest.current - step
        if (event.key === 'ArrowRight') next = latest.current + step
        if (next === null) return
        event.preventDefault()
        const clamped = clamp(next, min, max)
        latest.current = clamped
        onChange(clamped)
        onCommit(clamped)
      }}
      onDoubleClick={() => {
        const reset = side === 'right' ? 236 : 326
        latest.current = reset
        onChange(reset)
        onCommit(reset)
      }}
    />
  )
}
