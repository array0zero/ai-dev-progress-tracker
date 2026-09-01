const NEEDS_INPUT_LABEL = '要補完'

export interface ProgressSectionProps {
  title: string
  text?: string | null
  items?: string[]
  missing?: boolean
}

export function ProgressSection({ title, text, items, missing = false }: ProgressSectionProps) {
  return (
    <section className="progress-section">
      <h3>{title}</h3>
      {renderBody({ text, items, missing })}
    </section>
  )
}

function renderBody({
  text,
  items,
  missing,
}: Pick<ProgressSectionProps, 'text' | 'items' | 'missing'>) {
  if (missing) {
    return <p className="progress-section__needs-input">{NEEDS_INPUT_LABEL}</p>
  }
  if (items !== undefined) {
    if (items.length === 0) {
      return <p className="progress-section__needs-input">{NEEDS_INPUT_LABEL}</p>
    }
    return (
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    )
  }
  if (text === undefined || text === null || text === '') {
    return <p className="progress-section__needs-input">{NEEDS_INPUT_LABEL}</p>
  }
  return <p>{text}</p>
}
