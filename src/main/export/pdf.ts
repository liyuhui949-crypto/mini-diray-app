import fs from 'node:fs/promises'
import path from 'node:path'

import { BrowserWindow, app, protocol, session } from 'electron'
import sanitizeHtml from 'sanitize-html'

import { AppError } from '@shared/errors'
import { escapeHtml } from '@shared/markdown'

import { logger } from '../logger'
import { randomUuid } from '../vault/crypto'

export const PRINT_SCHEME = 'print'

const documents = new Map<string, string>()

/** 必须在 app ready 之前调用 */
export function registerPrintScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PRINT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

const FONT_FILES: Record<string, string> = {
  '400': 'noto-sans-sc-chinese-simplified-400-normal.woff2',
  '700': 'noto-sans-sc-chinese-simplified-700-normal.woff2',
  '400-latin': 'noto-sans-sc-latin-400-normal.woff2',
  '700-latin': 'noto-sans-sc-latin-700-normal.woff2'
}

function fontFilePath(name: string): string | null {
  const file = FONT_FILES[name]
  if (!file) return null
  // 打包后字体只保留 PDF 用到的 4 个文件，放在 Resources/fonts（extraResources）；
  // 开发态仍然从 node_modules 直接读
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'fonts')
    : path.join(app.getAppPath(), 'node_modules', '@fontsource', 'noto-sans-sc', 'files')
  return path.join(dir, file)
}

const PRINT_CSS = `
  @font-face {
    font-family: 'Noto Sans SC';
    font-weight: 400;
    font-display: block;
    src: url('./font/400') format('woff2');
  }
  @font-face {
    font-family: 'Noto Sans SC';
    font-weight: 700;
    font-display: block;
    src: url('./font/700') format('woff2');
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #1c1c1a; }
  body {
    font-family: 'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
    font-size: 11pt;
    line-height: 1.75;
  }
  .doc-header { margin-bottom: 18pt; border-bottom: 1px solid #e9e9e4; padding-bottom: 10pt; }
  .doc-header .meta { color: #6b6b66; font-size: 9.5pt; }
  .doc-header h1 { font-size: 20pt; margin: 4pt 0 6pt; letter-spacing: -0.01em; }
  .toc { columns: 2; column-gap: 24pt; font-size: 9.5pt; color: #6b6b66; margin: 0 0 18pt; padding: 0; list-style: none; }
  .toc li { margin: 0 0 3pt; }
  article.entry { page-break-inside: auto; margin: 0 0 22pt; }
  article.entry + article.entry { page-break-before: always; }
  article.entry h2 { font-size: 15pt; margin: 0 0 4pt; }
  .entry-meta { color: #9a9a94; font-size: 9pt; margin: 0 0 10pt; }
  .entry-body p { margin: 0 0 9pt; }
  .entry-body h1, .entry-body h2, .entry-body h3 { font-size: 13pt; margin: 14pt 0 6pt; page-break-after: avoid; }
  .entry-body blockquote { margin: 10pt 0; padding-left: 10pt; border-left: 2pt solid #d8d8d2; color: #6b6b66; }
  .entry-body ul, .entry-body ol { margin: 0 0 9pt; padding-left: 18pt; }
  .entry-body li { margin: 2pt 0; }
  .entry-body code { font-family: ui-monospace, Menlo, monospace; font-size: 9.5pt; background: #f4f4f1; padding: 0 3pt; border-radius: 3pt; }
  .entry-body pre { background: #f4f4f1; padding: 8pt; border-radius: 4pt; overflow: hidden; white-space: pre-wrap; }
  .entry-body hr { border: 0; border-top: 1px solid #e9e9e4; margin: 14pt 0; }
  .entry-body img { max-width: 100%; height: auto; border-radius: 4pt; page-break-inside: avoid; }
  figure { margin: 10pt 0; page-break-inside: avoid; }
  figcaption { color: #9a9a94; font-size: 9pt; margin-top: 4pt; }
  .media-card {
    display: flex; gap: 8pt; align-items: center; margin: 10pt 0; padding: 8pt;
    border: 1px solid #e9e9e4; border-radius: 6pt; page-break-inside: avoid;
  }
  .media-card .badge { font-size: 9pt; color: #2f6f4e; background: #e9f1ec; border-radius: 4pt; padding: 1pt 5pt; }
  .tag-list { display: flex; flex-wrap: wrap; gap: 5pt; margin: 0 0 10pt; padding: 0; list-style: none; }
  .tag-list li { font-size: 9pt; color: #6b6b66; background: #f4f4f1; border-radius: 999pt; padding: 1pt 7pt; }
  .attachment-list { font-size: 9pt; color: #6b6b66; margin: 8pt 0 0; padding: 0; list-style: none; }
  .page-footer { color: #9a9a94; font-size: 8.5pt; margin-top: 20pt; border-top: 1px solid #e9e9e4; padding-top: 6pt; }
`

export function sanitizePrintHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'article', 'section', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote',
      'hr', 'br', 'img', 'figure', 'figcaption', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'header', 'footer', 'sup', 'sub'
    ],
    allowedAttributes: {
      img: ['src', 'alt', 'width', 'height'],
      a: ['href', 'title'],
      '*': ['class']
    },
    allowedSchemes: ['attachment', 'data'],
    allowedSchemesByTag: {
      img: ['attachment', 'data'],
      a: ['attachment']
    },
    transformTags: {
      a: (tagName, attribs) => {
        const { href, ...rest } = attribs
        return { tagName, attribs: href && href.startsWith('attachment://') ? { ...rest, href } : rest }
      },
      img: (tagName, attribs) => {
        const src = attribs.src ?? ''
        if (!src.startsWith('attachment://')) return { tagName, attribs: { ...attribs, src: '' } }
        return { tagName, attribs }
      }
    }
  })
}

export function buildPrintDocument(options: {
  title: string
  subtitle?: string
  bodyHtml: string
}): string {
  const safeBody = sanitizePrintHtml(options.bodyHtml)
  const subtitle = options.subtitle ? `<p class="meta">${escapeHtml(options.subtitle)}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src attachment: data:; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'" />
<title>${escapeHtml(options.title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<header class="doc-header">
  <h1>${escapeHtml(options.title)}</h1>
  ${subtitle}
</header>
${safeBody}
<footer class="page-footer">由 Mini Diary 生成 · 内容来自本机加密日记库</footer>
</body>
</html>`
}

/**
 * 用隐藏窗口打印 PDF：
 * - HTML 通过内存中的 `print://<token>/doc` 提供，不落明文临时文件；
 * - 使用独立 session（禁用 cache）+ 同一个 `attachment://` 解密代理；
 * - 打印完成后销毁窗口、清缓存、解绑协议。
 */
export async function exportPdf(options: {
  html: string
  targetPath: string
  attachmentHandler: (request: Request) => Promise<Response>
  title: string
}): Promise<void> {
  const token = randomUuid().replace(/-/g, '')
  documents.set(token, options.html)

  const partition = `print-${token}`
  const printSession = session.fromPartition(partition, { cache: false })

  const serve = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const pathname = url.pathname === '' ? '/' : url.pathname
    if (pathname === '/doc' || pathname === '/') {
      const html = documents.get(url.hostname) ?? ''
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      })
    }
    const fontMatch = /^\/font\/([\w-]+)$/.exec(pathname)
    if (fontMatch) {
      const file = fontFilePath(fontMatch[1] ?? '')
      if (!file) return new Response(null, { status: 404 })
      const data = await fs.readFile(file).catch(() => null)
      if (!data) return new Response(null, { status: 404 })
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'no-store' }
      })
    }
    return new Response(null, { status: 404 })
  }

  printSession.protocol.handle(PRINT_SCHEME, serve)
  printSession.protocol.handle('attachment', options.attachmentHandler)

  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      session: printSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      offscreen: false,
      spellcheck: false
    }
  })

  try {
    await window.loadURL(`${PRINT_SCHEME}://${token}/doc`)
    // 等字体与图片就绪，避免 PDF 里图片空白
    await window.webContents.executeJavaScript(
      `(async () => {
         try { await document.fonts.ready } catch {}
         await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => undefined)))
         return true
       })()`,
      true
    )
    const pdf = await window.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
    await fs.writeFile(options.targetPath, pdf, { mode: 0o600 })
    logger.info('pdf exported', { bytes: pdf.length })
  } catch (error) {
    logger.error('pdf export failed', error)
    throw new AppError('IO_ERROR', 'PDF 导出失败')
  } finally {
    documents.delete(token)
    if (!window.isDestroyed()) window.destroy()
    try {
      printSession.protocol.unhandle(PRINT_SCHEME)
      printSession.protocol.unhandle('attachment')
    } catch {
      // 协议可能已经解绑
    }
    await printSession.clearCache().catch(() => undefined)
  }
}
