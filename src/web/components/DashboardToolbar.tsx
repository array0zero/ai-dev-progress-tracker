export type DashboardStateFilter = 'has_next_action' | 'needs_review' | 'unreflected'

export type DashboardView = 'dense' | 'compact'

export const STATE_FILTERS: ReadonlyArray<{ id: DashboardStateFilter; label: string }> = [
  { id: 'has_next_action', label: '次の作業あり' },
  { id: 'needs_review', label: '要確認' },
  { id: 'unreflected', label: '未反映' },
]

export interface DashboardToolbarProps {
  filters: readonly DashboardStateFilter[]
  onToggleFilter: (filter: DashboardStateFilter) => void
  view: DashboardView
  onViewChange: (view: DashboardView) => void
  query: string
  onQueryChange: (query: string) => void
  searchEnabled?: boolean
  visibleCount: number
  totalCount: number
}

export function DashboardToolbar({
  filters,
  onToggleFilter,
  view,
  onViewChange,
  query,
  onQueryChange,
  searchEnabled = true,
  visibleCount,
  totalCount,
}: DashboardToolbarProps) {
  return (
    <section className="toolbar" aria-label="表示条件">
      <fieldset className="toolbar__filters">
        <legend className="toolbar__legend">状態で絞り込み</legend>
        {STATE_FILTERS.map((filter) => (
          <label key={filter.id} className="toolbar__filter">
            <input
              type="checkbox"
              checked={filters.includes(filter.id)}
              onChange={() => onToggleFilter(filter.id)}
            />
            {filter.label}
          </label>
        ))}
      </fieldset>
      <label className="toolbar__search" hidden={!searchEnabled}>
        検索
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="プロジェクト名・キーワード"
        />
      </label>
      <fieldset className="toolbar__view">
        <legend className="toolbar__legend">表示</legend>
        {(['dense', 'compact'] as const).map((value) => (
          <label key={value} className="toolbar__filter">
            <input
              type="radio"
              name="dashboard-view"
              value={value}
              checked={view === value}
              onChange={() => onViewChange(value)}
            />
            {value === 'dense' ? '高密度' : 'カード'}
          </label>
        ))}
      </fieldset>
      <span className="toolbar__count">
        {visibleCount} / {totalCount}
      </span>
    </section>
  )
}
