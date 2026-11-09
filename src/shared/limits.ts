/**
 * 跨进程共享的阈值。主进程与渲染进程都从这里取，避免两份常量漂移。
 */

/** 单个附件超过这个体积时，添加前需要用户确认 */
export const LARGE_FILE_CONFIRM_BYTES = 300 * 1024 * 1024

/** 编辑器里直接粘贴图片的上限 */
export const PASTE_IMAGE_MAX_BYTES = 50 * 1024 * 1024
