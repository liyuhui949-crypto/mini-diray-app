/**
 * HTTP Range 解析（纯函数，便于单测）。
 * 只支持单区间；多区间或语法错误一律视为非法（返回 null），由调用方回 416。
 */

export interface ByteRange {
  start: number
  /** 闭区间终点 */
  end: number
}

/**
 * 支持三种写法：
 *   bytes=start-end
 *   bytes=start-     （到结尾）
 *   bytes=-suffix    （最后 N 字节）
 */
export function parseRangeHeader(header: string | null | undefined, size: number): ByteRange | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startText = '', endText = ''] = match
  if (startText === '' && endText === '') return null

  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(startText)
  if (!Number.isFinite(start) || start < 0 || start >= size) return null
  if (endText === '') return { start, end: size - 1 }

  const end = Number(endText)
  if (!Number.isFinite(end) || end < start) return null
  return { start, end: Math.min(end, size - 1) }
}

export function contentRangeHeader(range: ByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}

export function unsatisfiedRangeHeader(size: number): string {
  return `bytes */${size}`
}
