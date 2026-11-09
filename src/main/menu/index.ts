import { Menu, app, dialog, type MenuItemConstructorOptions } from 'electron'

import { copy } from '@shared/copy'
import { EVENTS } from '@shared/ipc'
import type { MenuCommand } from '@shared/types'

import { broadcast } from '../broadcast'
import type { AppContext } from '../context'

const isMac = process.platform === 'darwin'

function isDev(): boolean {
  return !app.isPackaged
}

function send(command: MenuCommand): void {
  broadcast(EVENTS.menuCommand, command)
}

export function buildApplicationMenu(context: AppContext): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: copy.appName,
            submenu: [
              {
                label: copy.menu.about,
                click: () => showAbout(context)
              },
              { type: 'separator' },
              { role: 'hide', label: copy.menu.hide },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: copy.menu.quit }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: copy.menu.file,
      submenu: [
        { label: copy.menu.newEntry, accelerator: 'CmdOrCtrl+N', click: () => send('new-entry') },
        { label: copy.menu.goToday, accelerator: 'CmdOrCtrl+T', click: () => send('go-today') },
        { type: 'separator' },
        { label: copy.menu.importEntry, click: () => send('import-entry') },
        { label: copy.menu.exportEntry, click: () => send('export-entry') },
        { type: 'separator' },
        { label: copy.menu.migrationExport, click: () => send('migration-export') },
        { label: copy.menu.migrationImport, click: () => send('migration-import') },
        { type: 'separator' },
        {
          label: copy.menu.lock,
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            void context.lock('manual')
          }
        },
        { label: copy.menu.preferences, accelerator: 'CmdOrCtrl+,', click: () => send('open-preferences') },
        { type: 'separator' },
        ...(isMac
          ? ([{ role: 'close', label: '关闭窗口' }] satisfies MenuItemConstructorOptions[])
          : ([{ role: 'quit', label: copy.menu.quit }] satisfies MenuItemConstructorOptions[]))
      ]
    },
    {
      label: copy.menu.edit,
      submenu: [
        { role: 'undo', label: copy.menu.undo },
        { role: 'redo', label: copy.menu.redo },
        { type: 'separator' },
        { role: 'cut', label: copy.menu.cut },
        { role: 'copy', label: copy.menu.copy },
        { role: 'paste', label: copy.menu.paste },
        { role: 'selectAll', label: copy.menu.selectAll },
        { type: 'separator' },
        { label: copy.menu.find, accelerator: 'CmdOrCtrl+F', click: () => send('search') },
        {
          label: copy.attachments.add,
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => send('insert-attachment')
        }
      ]
    },
    {
      label: copy.menu.view,
      submenu: [
        { label: copy.menu.stats, accelerator: 'CmdOrCtrl+Y', click: () => send('open-stats') },
        {
          label: copy.menu.toggleSidebar,
          accelerator: 'CmdOrCtrl+Alt+B',
          click: () => send('toggle-sidebar')
        },
        { type: 'separator' },
        { role: 'resetZoom', label: copy.menu.actualSize },
        { role: 'zoomIn', label: copy.menu.zoomIn },
        { role: 'zoomOut', label: copy.menu.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: copy.menu.toggleFullScreen },
        ...(isDev()
          ? ([
              { type: 'separator' },
              { role: 'reload', label: copy.menu.reload },
              { role: 'toggleDevTools', label: copy.menu.devTools }
            ] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      label: copy.menu.window,
      submenu: [
        { role: 'minimize', label: copy.menu.minimize },
        { role: 'zoom', label: copy.menu.zoom },
        ...(isMac
          ? ([
              { type: 'separator' },
              { role: 'front', label: copy.menu.front }
            ] satisfies MenuItemConstructorOptions[])
          : ([] satisfies MenuItemConstructorOptions[]))
      ]
    },
    ...(isMac
      ? []
      : [
          {
            label: copy.menu.help,
            submenu: [
              {
                label: copy.menu.about,
                click: () => showAbout(context)
              }
            ]
          }
        ])
  ]

  return Menu.buildFromTemplate(template)
}

export function installApplicationMenu(context: AppContext): void {
  Menu.setApplicationMenu(buildApplicationMenu(context))
}

function showAbout(context: AppContext): void {
  const window = context.mainWindow()
  const detail = [
    `版本 ${context.appVersion}`,
    `加密 AES-256-GCM · scrypt N=2¹⁷`,
    '本地优先、默认加密、离线可用',
    '已知限制：不支持 HEVC / MKV；无视频缩略图',
    '无备份功能：迁移包是唯一的完整副本'
  ].join('\n')
  const options = {
    type: 'info' as const,
    title: copy.menu.about,
    message: `${copy.appName}`,
    detail,
    buttons: ['好']
  }
  if (window) void dialog.showMessageBox(window, options)
  else void dialog.showMessageBox(options)
}
