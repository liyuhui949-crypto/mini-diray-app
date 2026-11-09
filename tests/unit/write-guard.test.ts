import { describe, expect, it } from 'vitest'

import { isWritableDate } from '@shared/writeGuard'

const base = { today: '2026-11-07', allowFutureEntries: false }

describe('可写性铁律', () => {
  it('只有今天可写', () => {
    expect(isWritableDate('2026-11-07', base)).toBe(true)
    expect(isWritableDate('2026-11-06', base)).toBe(false)
    expect(isWritableDate('2026-10-01', base)).toBe(false)
    expect(isWritableDate('2026-11-08', base)).toBe(false)
  })

  it('打开 allowFutureEntries 只放开未来，历史仍然封存', () => {
    const options = { ...base, allowFutureEntries: true }
    expect(isWritableDate('2026-11-08', options)).toBe(true)
    expect(isWritableDate('2026-11-06', options)).toBe(false)
  })

  it('测试/演示通道可以写历史', () => {
    expect(isWritableDate('2026-10-01', { ...base, allowHistory: true })).toBe(true)
    expect(isWritableDate('2026-11-08', { ...base, allowHistory: true })).toBe(true)
  })
})
