// electron-builder CLI 在 Node 24 下传参有问题，这里直接调 API 打一个未签名的 .app
import { build } from 'electron-builder'

await build({ dir: true, publish: 'never' })
console.log('packaged to release/')
