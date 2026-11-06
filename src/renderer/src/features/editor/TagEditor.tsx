import { useState } from 'react'

import { X } from 'lucide-react'

import { copy } from '@shared/copy'
import { normalizeTags, TAG_MAX_LENGTH } from '@shared/schemas'

import styles from './tags.module.scss'

interface TagEditorProps {
  tags: readonly string[]
  onChange: (tags: string[]) => void
  readOnly?: boolean
}

export function TagEditor({ tags, onChange, readOnly }: TagEditorProps): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState('')

  const commit = (): void => {
    const next = normalizeTags([...tags, value])
    onChange(next)
    setValue('')
    setAdding(false)
  }

  return (
    <div className={styles.tags}>
      {tags.map((tag) => (
        <span key={tag} className={styles.chip}>
          <span className={styles.hash}>#</span>
          {tag}
          {readOnly ? null : (
            <button
              type="button"
              className={styles.remove}
              aria-label={`删除标签 ${tag}`}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
            >
              <X size={10} />
            </button>
          )}
        </span>
      ))}

      {readOnly ? null : adding ? (
        <input
          autoFocus
          className={styles.input}
          value={value}
          maxLength={TAG_MAX_LENGTH}
          placeholder={copy.editor.tagPlaceholder}
          aria-label={copy.editor.tagPlaceholder}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault()
              commit()
            }
            if (event.key === 'Escape') {
              setValue('')
              setAdding(false)
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => setAdding(true)}
          aria-label={copy.editor.addTag}
        >
          {copy.editor.addTag}
        </button>
      )}
    </div>
  )
}
