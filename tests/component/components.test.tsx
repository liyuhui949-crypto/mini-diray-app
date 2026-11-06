// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Attachment, DiaryEntry } from '@shared/types'

import { CalendarPane } from '@/features/calendar/CalendarPane'
import { MarkdownPreview } from '@/features/editor/MarkdownPreview'
import { TagEditor } from '@/features/editor/TagEditor'

afterEach(() => {
  cleanup()
})

const entries: DiaryEntry[] = [
  {
    date: '2026-11-06',
    title: '雨停之后',
    body: '下午四点雨停了。',
    tags: ['日常'],
    attachments: [],
    wordCount: 9,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z'
  }
]

function renderCalendar(overrides: Partial<React.ComponentProps<typeof CalendarPane>> = {}) {
  const props = {
    cursor: '2026-11-01',
    today: '2026-11-06',
    selected: '2026-11-06',
    entries,
    firstDayOfWeek: 1 as const,
    allowFutureEntries: false,
    onCursorChange: vi.fn(),
    onSelect: vi.fn(),
    ...overrides
  }
  render(<CalendarPane {...props} />)
  return props
}

describe('月历', () => {
  it('渲染固定 42 格，跨月日期灰显', () => {
    renderCalendar()
    expect(screen.getAllByRole('gridcell')).toHaveLength(42)
    expect(screen.getByText('2026年11月')).toBeInTheDocument()
    expect(screen.getByLabelText('2026年11月6日，有日记')).toBeInTheDocument()
  })

  it('点击日期切换，未来日期在关闭偏好时不可点', async () => {
    const user = userEvent.setup()
    const props = renderCalendar()
    await user.click(screen.getByLabelText('2026年11月5日'))
    expect(props.onSelect).toHaveBeenCalledWith('2026-11-05')

    expect(screen.getByLabelText('2026年11月7日，未来日期')).toBeDisabled()
    expect(screen.getByLabelText('2026年11月6日，有日记')).not.toBeDisabled()
  })

  it('允许未来日期时可以点击', async () => {
    const user = userEvent.setup()
    const props = renderCalendar({ allowFutureEntries: true })
    const future = screen.getByLabelText('2026年11月7日')
    expect(future).not.toBeDisabled()
    await user.click(future)
    expect(props.onSelect).toHaveBeenCalledWith('2026-11-07')
  })

  it('上/下月切换更新游标', async () => {
    const user = userEvent.setup()
    const props = renderCalendar()
    await user.click(screen.getByLabelText('上个月'))
    expect(props.onCursorChange).toHaveBeenCalledWith('2026-10-01')
    await user.click(screen.getByLabelText('下个月'))
    expect(props.onCursorChange).toHaveBeenCalledWith('2026-12-01')
  })

  it('键盘可以移动选择', async () => {
    const user = userEvent.setup()
    const props = renderCalendar()
    const selected = screen.getByLabelText('2026年11月6日，有日记')
    selected.focus()
    await user.keyboard('{ArrowRight}')
    // 11-07 是未来日期，关闭偏好时既不选中也不换月
    expect(props.onSelect).not.toHaveBeenCalled()

    await user.keyboard('{ArrowLeft}')
    expect(props.onSelect).toHaveBeenCalledWith('2026-11-05')

    await user.keyboard('{PageDown}')
    expect(props.onCursorChange).toHaveBeenCalledWith('2026-12-01')
  })
})

describe('标签编辑', () => {
  it('输入标签后回车添加，重复与小写会被规范化', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TagEditor tags={['日常']} onChange={onChange} />)

    await user.click(screen.getByLabelText('＋ 标签'))
    const input = screen.getByLabelText('标签名，回车确认')
    await user.type(input, '思考{Enter}')
    expect(onChange).toHaveBeenCalledWith(['日常', '思考'])

    await user.click(screen.getByLabelText('＋ 标签'))
    await user.type(screen.getByLabelText('标签名，回车确认'), ' 日常 {Enter}')
    expect(onChange).toHaveBeenLastCalledWith(['日常'])
  })

  it('点击 × 删除标签', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<TagEditor tags={['日常', '思考']} onChange={onChange} />)
    await user.click(screen.getByLabelText('删除标签 日常'))
    expect(onChange).toHaveBeenCalledWith(['思考'])
  })

  it('只读时不显示删除与添加', () => {
    render(<TagEditor tags={['日常']} onChange={vi.fn()} readOnly />)
    expect(screen.queryByLabelText('删除标签 日常')).toBeNull()
    expect(screen.queryByLabelText('＋ 标签')).toBeNull()
  })
})


describe('Markdown 预览', () => {
  const image: Attachment = {
    id: '6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e',
    name: '窗外的梧桐.png',
    mime: 'image/png',
    kind: 'image',
    size: 2048,
    sha256: 'a'.repeat(64),
    chunkSize: 1024 * 1024,
    totalChunks: 1,
    createdAt: '2026-11-06T00:00:00.000Z'
  }

  it('放行 attachment:// 图片（react-markdown 默认会抹掉未知协议）', () => {
    render(<MarkdownPreview body={`![梧桐](attachment://${image.id})`} attachments={[image]} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', `attachment://${image.id}`)
    expect(img).toHaveAttribute('alt', '窗外的梧桐.png')
  })

  it('音频与视频渲染为原生播放器卡片', () => {
    const audio: Attachment = { ...image, id: '00000000-0000-4000-8000-00000000000a', name: '录音.m4a', kind: 'audio', mime: 'audio/mp4' }
    const video: Attachment = { ...image, id: '00000000-0000-4000-8000-00000000000b', name: '雨声.mp4', kind: 'video', mime: 'video/mp4' }
    const { container } = render(
      <MarkdownPreview
        body={`[录音](attachment://${audio.id})\n\n[雨声](attachment://${video.id})`}
        attachments={[audio, video]}
      />
    )
    expect(container.querySelector('audio')?.getAttribute('src')).toBe(`attachment://${audio.id}`)
    expect(container.querySelector('video')?.getAttribute('src')).toBe(`attachment://${video.id}`)
  })

  it('外部链接只保留 https，越界协议不生成 href', () => {
    render(
      <MarkdownPreview
        body={'[外链](https://example.com)\n\n[坏链](javascript:alert(1))'}
        attachments={[]}
      />
    )
    const link = screen.getByText('外链').closest('a')
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(screen.getByText('坏链').closest('a')).toBeNull()
  })
})
