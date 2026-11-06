// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Attachment, DiaryEntry } from '@shared/types'

import { CalendarPane } from '@/features/calendar/CalendarPane'
import { EntryList } from '@/features/entry-list/EntryList'
import { SearchPane } from '@/features/search/SearchPane'
import { SearchPreviewDialog } from '@/features/search/SearchPreviewDialog'
import { MarkdownPreview } from '@/features/editor/MarkdownPreview'
import { useEntriesStore } from '@/stores/entries'
import { useUiStore } from '@/stores/ui'
import { TagEditor } from '@/features/editor/TagEditor'
import { PasswordInput } from '@/components/ui'

afterEach(() => {
  cleanup()
})

describe('PasswordInput', () => {
  it('默认隐藏，点眼睛可以查看与再次隐藏', async () => {
    const user = userEvent.setup()
    render(<PasswordInput defaultValue="secret-1234" aria-label="密码" />)
    const input = screen.getByLabelText('密码') as HTMLInputElement
    expect(input.type).toBe('password')

    await user.click(screen.getByRole('button', { name: '显示密码' }))
    expect(input.type).toBe('text')
    expect(input.value).toBe('secret-1234')

    await user.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(input.type).toBe('password')
  })

  it('切换按钮不会提交所在表单', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <PasswordInput defaultValue="x" aria-label="密码" />
      </form>
    )
    await user.click(screen.getByRole('button', { name: '显示密码' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })
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


describe('条目列表范围', () => {
  const october = {
    date: '2026-10-05',
    title: '十月的日记',
    body: '十月正文',
    tags: ['日常'],
    attachments: [],
    wordCount: 4,
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z'
  }
  const november = {
    date: '2026-11-06',
    title: '十一月的日记',
    body: '十一月正文',
    tags: ['工作'],
    attachments: [],
    wordCount: 4,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z'
  }

  beforeEach(() => {
    useEntriesStore.setState({
      entries: [october, november],
      activeDate: '2026-11-06',
      searchQuery: '',
      activeTag: null
    })
    useUiStore.setState({ calendarMonth: '2026-10-01', listScope: 'month' })
  })

  it('默认只显示日历当前月份的条目', () => {
    render(<EntryList collapsed={false} />)
    expect(screen.getByText('2026年10月')).toBeInTheDocument()
    expect(screen.getByText('十月的日记')).toBeInTheDocument()
    expect(screen.queryByText('十一月的日记')).toBeNull()
    expect(screen.getByText('1 篇 · 共 4 字')).toBeInTheDocument()
  })

  it('切到“全部”后显示所有月份', async () => {
    const user = userEvent.setup()
    render(<EntryList collapsed={false} />)
    await user.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByText('全部条目')).toBeInTheDocument()
    expect(screen.getByText('十月的日记')).toBeInTheDocument()
    expect(screen.getByText('十一月的日记')).toBeInTheDocument()
  })

  it('搜索跨月份，且不再受列表范围限制', () => {
    useEntriesStore.setState({ searchQuery: '十一月' })
    render(<EntryList collapsed={false} />)
    expect(screen.getByText('搜索结果')).toBeInTheDocument()
    expect(screen.getByText('1 个结果')).toBeInTheDocument()
    // 命中处被 <mark> 切开，这里用日期行判断是哪一篇
    expect(screen.getByText('11月6日 · 星期五')).toBeInTheDocument()
    expect(screen.queryByText('10月5日 · 星期一')).toBeNull()
  })

  it('检索洞察：概览篇数、年份分组与预览对话框', async () => {
    const user = userEvent.setup()
    useEntriesStore.setState({
      searchQuery: '下雨',
      entries: [
        { ...entries[0]!, date: '2026-11-06', title: '雨停之后', body: '下午还在下雨，四点才停。' },
        { ...entries[0]!, date: '2025-12-30', title: '', body: '下雨，没出门。' },
        { ...entries[0]!, date: '2025-12-31', title: '', body: '还在下雨。' }
      ]
    })
    render(
      <>
        <SearchPane />
        <SearchPreviewDialog />
      </>
    )
    expect(screen.getByTestId('search-hit-count')).toHaveTextContent('3篇')
    expect(screen.getByText('2025 年 · 2 篇')).toBeInTheDocument()
    expect(screen.getByText('2026 年 · 1 篇')).toBeInTheDocument()

    await user.click(screen.getByTestId('search-row-2025-12-30'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('正文中 1 处提到「下雨」')).toBeInTheDocument()
  })

  it('标签筛选也是全库视图', () => {
    useEntriesStore.setState({ activeTag: '工作' })
    render(<EntryList collapsed={false} />)
    expect(screen.getByText('标签 #工作')).toBeInTheDocument()
    expect(screen.getByText('十一月的日记')).toBeInTheDocument()
  })
})
