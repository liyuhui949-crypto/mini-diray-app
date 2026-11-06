import { describe, expect, it } from 'vitest'

import {
  applyCommand,
  attachmentMarkdown,
  collectAttachmentRefs,
  insertAtSelection,
  toggleLinePrefix,
  wrapSelection
} from '../../src/renderer/src/features/editor/markdownCommands'

describe('Markdown 编辑命令', () => {
  it('包裹选中文本，再执行一次取消包裹', () => {
    const source = { text: '今天很好', selectionStart: 0, selectionEnd: 2 }
    const bold = wrapSelection(source, '**', '**')
    expect(bold.text).toBe('**今天**很好')
    expect([bold.selectionStart, bold.selectionEnd]).toEqual([2, 4])

    const again = wrapSelection(bold, '**', '**')
    expect(again.text).toBe('今天很好')
    expect([again.selectionStart, again.selectionEnd]).toEqual([0, 2])
  })

  it('空选区插入占位文字并选中', () => {
    const result = wrapSelection({ text: 'abc', selectionStart: 3, selectionEnd: 3 }, '*', '*', '斜体')
    expect(result.text).toBe('abc*斜体*')
    expect(result.text.slice(result.selectionStart, result.selectionEnd)).toBe('斜体')
  })

  it('列表前缀按行添加与移除', () => {
    const source = { text: '第一行\n第二行', selectionStart: 0, selectionEnd: 7 }
    const ul = toggleLinePrefix(source, false)
    expect(ul.text).toBe('- 第一行\n- 第二行')
    const removed = toggleLinePrefix(ul, false)
    expect(removed.text).toBe('第一行\n第二行')

    const ol = toggleLinePrefix(source, true)
    expect(ol.text).toBe('1. 第一行\n2. 第二行')
  })

  it('空行不会被加前缀', () => {
    const result = toggleLinePrefix({ text: 'a\n\nb', selectionStart: 0, selectionEnd: 4 }, false)
    expect(result.text).toBe('- a\n\n- b')
  })

  it('applyCommand 覆盖四种格式', () => {
    const source = { text: '文字', selectionStart: 0, selectionEnd: 2 }
    expect(applyCommand(source, 'bold').text).toBe('**文字**')
    expect(applyCommand(source, 'italic').text).toBe('*文字*')
    expect(applyCommand(source, 'unorderedList').text).toBe('- 文字')
    expect(applyCommand(source, 'orderedList').text).toBe('1. 文字')
  })

  it('插入附件引用时区分图片与其他文件', () => {
    expect(
      attachmentMarkdown({
        id: '6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e',
        name: '窗外的梧桐.png',
        kind: 'image'
      })
    ).toBe('![窗外的梧桐.png](attachment://6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e)')
    expect(
      attachmentMarkdown({
        id: '6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e',
        name: '录音.m4a',
        kind: 'audio'
      })
    ).toBe('[录音.m4a](attachment://6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e)')
  })

  it('在光标处插入文本并移动光标', () => {
    const result = insertAtSelection({ text: 'ab', selectionStart: 1, selectionEnd: 1 }, 'X')
    expect(result.text).toBe('aXb')
    expect(result.selectionStart).toBe(2)
  })

  it('从正文里收集去重后的附件引用', () => {
    const id = '6d5f1c1e-8f4a-4a7b-9c1d-2f3a4b5c6d7e'
    expect(
      collectAttachmentRefs(`![a](attachment://${id}) 和 [b](attachment://${id.toUpperCase()})`)
    ).toEqual([id])
    expect(collectAttachmentRefs('没有引用')).toEqual([])
  })
})
