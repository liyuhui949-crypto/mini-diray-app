import { useEffect, useState } from 'react'

import { copy } from '@shared/copy'
import { formatDateCN, isValidLocalDate } from '@shared/date'
import type { LocalDate } from '@shared/types'

import { Button, Dialog, Field, Input } from '@/components/ui'

interface JumpToDateDialogProps {
  open: boolean
  onClose: () => void
  today: LocalDate
  allowFutureEntries: boolean
  onPick: (date: LocalDate) => void
}

/** 手动跳转到某一天：非法日期与（关闭偏好时的）未来日期都会被拒绝 */
export function JumpToDateDialog({
  open,
  onClose,
  today,
  allowFutureEntries,
  onPick
}: JumpToDateDialogProps): React.JSX.Element {
  const [value, setValue] = useState(today)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setValue(today)
      setError(null)
    }
  }, [open, today])

  const submit = (): void => {
    if (!isValidLocalDate(value)) {
      setError('日期不合法')
      return
    }
    if (!allowFutureEntries && value > today) {
      setError('不能跳到未来日期；可以在设置里允许写未来日记')
      return
    }
    onPick(value)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      width={420}
      title={copy.sidebar.jumpToDate}
      description={formatDateCN(value)}
      footer={
        <>
          <Button onClick={onClose}>{copy.common.cancel}</Button>
          <Button variant="primary" onClick={submit}>
            跳转
          </Button>
        </>
      }
    >
      <Field label="日期" htmlFor="jump-date" hint={error ?? undefined}>
        <Input
          id="jump-date"
          type="date"
          value={value}
          max={allowFutureEntries ? undefined : today}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
      </Field>
    </Dialog>
  )
}
