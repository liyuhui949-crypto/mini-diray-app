import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Mini Diary',
  description: '本地优先、端到端加密的桌面日记',
  base: '/mini-diray-app/',
  cleanUrls: false,
  lastUpdated: true,
  head: [['meta', { name: 'theme-color', content: '#2f6f5e' }]],
  themeConfig: {
    nav: [
      { text: '功能', link: '/features' },
      { text: '使用说明', link: '/usage' },
      { text: '隐私与安全', link: '/privacy' }
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '项目介绍', link: '/' },
          { text: '功能', link: '/features' }
        ]
      },
      {
        text: '使用',
        items: [
          { text: '使用说明', link: '/usage' },
          { text: '隐私与安全', link: '/privacy' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/liyuhui949-crypto/mini-diray-app' }
    ],
    footer: {
      message: '本地优先、默认加密的桌面日记',
      copyright: 'MIT License'
    },
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    search: { provider: 'local' }
  }
})
