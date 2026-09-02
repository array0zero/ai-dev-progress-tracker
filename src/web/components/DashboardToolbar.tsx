export type DashboardStateFilter = 'has_next_action' | 'needs_review' | 'unreflected'

export const STATE_FILTERS: ReadonlyArray<{ id: DashboardStateFilter; label: string }> = [
  { id: 'has_next_action', label: '次の作業あり' },
  { id: 'needs_review', label: '要確認' },
  { id: 'unreflected', label: '未反映' },
]

export interface DashboardToolbarProps {
  filters: readonly DashboardStateFilter[]
  onToggleFilter: (filter: DashboardStateFilter) => void
  query: string
  onQueryChange: (query: string) => void
  /** search UI は T020 で有効化する。 */
  searchEnabled?: boolean
  visibleCount: number
  totalCount: number
}

export function DashboardToolbar({
  filters,
  onToggleFilter,
  query,
  onQueryChange,
  searchEnabled = false,
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
      <span className="toolbar__count">
        {visibleCount} / {totalCount}
      </span>
    </section>
  )
}
