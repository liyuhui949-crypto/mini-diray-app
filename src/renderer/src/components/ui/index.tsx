import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Eye, EyeOff } from 'lucide-react'
import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes
} from 'react'

import { copy } from '@shared/copy'

import { useUiStore } from '@/stores/ui'

import styles from './ui.module.scss'

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'default'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: ReactNode
}

const variantClass: Record<ButtonVariant, string> = {
  primary: styles.btnPrimary ?? '',
  ghost: styles.btnGhost ?? '',
  danger: styles.btnDanger ?? '',
  default: ''
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, className, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      className={[styles.btn, size === 'sm' ? styles.btnSm : '', variantClass[variant], className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
})

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, className, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={[styles.iconBtn, active ? styles.iconBtnActive : '', className].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
})

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={[styles.input, className].filter(Boolean).join(' ')} {...rest} />
  }
)

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** 外层容器，用于在特殊布局里补 padding 等 */
  containerClassName?: string
}

/** 带"显示/隐藏"切换的密码框：所有密码输入都走这个组件 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, containerClassName, ...rest }, ref) {
    const [visible, setVisible] = useState(false)
    const label = visible ? copy.common.hidePassword : copy.common.showPassword
    return (
      <div className={[styles.passwordField, containerClassName].filter(Boolean).join(' ')}>
        <input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={[styles.input, styles.passwordInput, className].filter(Boolean).join(' ')}
          {...rest}
        />
        <button
          type="button"
          className={styles.passwordToggle}
          aria-label={label}
          title={label}
          aria-pressed={visible}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    )
  }
)

interface FieldProps {
  label: string
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}

export function Field({ label, hint, htmlFor, children }: FieldProps): React.JSX.Element {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  )
}

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={styles.switch}
      onClick={() => onChange(!checked)}
    />
  )
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string }>
}

export function Select({ options, className, ...rest }: SelectProps): React.JSX.Element {
  return (
    <select className={[styles.select, className].filter(Boolean).join(' ')} {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

interface ProgressProps {
  value: number
  label: string
  detail?: string
}

export function Progress({ value, label, detail }: ProgressProps): React.JSX.Element {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div>
      <div className={styles.progressTrack}>
        <div
          className={styles.progressFill}
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={label}
        />
      </div>
      <div className={styles.progressMeta}>
        <span>{label}</span>
        <em>{detail ?? `${percent}%`}</em>
      </div>
    </div>
  )
}

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  width?: number
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  width
}: DialogProps): React.JSX.Element {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content
          className={styles.dialog}
          style={width ? { width: `min(${width}px, 100%)` } : undefined}
        >
          <DialogPrimitive.Title className={styles.dialogTitle}>{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className={styles.dialogSub}>
              {description}
            </DialogPrimitive.Description>
          ) : null}
          {children}
          {footer ? <div className={styles.dialogFooter}>{footer}</div> : null}
          <DialogPrimitive.Close className={styles.dialogClose} aria-label={copy.common.close}>
            ×
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function ToastHost(): React.JSX.Element {
  const toasts = useUiStore((state) => state.toasts)
  const dismiss = useUiStore((state) => state.dismissToast)
  return (
    <div className={styles.toastHost} aria-live="polite" role="status">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={[
            styles.toast,
            toast.tone === 'error' ? styles.toastError : '',
            toast.tone === 'success' ? styles.toastSuccess : ''
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span>{toast.message}</span>
          {toast.action ? (
            <button
              type="button"
              className={styles.toastAction}
              onClick={() => {
                toast.action?.onClick()
                dismiss(toast.id)
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export { styles as uiStyles }
