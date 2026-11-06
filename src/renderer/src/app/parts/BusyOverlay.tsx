import { copy } from '@shared/copy'
import { formatBytes } from '@shared/date'

import { Progress } from '@/components/ui'
import { useVaultStore } from '@/stores/vault'

import styles from './busy.module.scss'

export function BusyOverlay(): React.JSX.Element | null {
  const busy = useVaultStore((state) => state.busy)
  if (!busy) return null

  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.dot} />
          <span>{copy.common.loading}</span>
        </div>
        <Progress
          value={busy.ratio}
          label={busy.label}
          detail={busy.bytesTotal ? formatBytes(busy.bytesDone ?? 0) : undefined}
        />
      </div>
    </div>
  )
}
