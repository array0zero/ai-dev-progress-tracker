import { DashboardPage } from './pages/DashboardPage.js'
import { ProjectDetailPage } from './pages/ProjectDetailPage.js'

export function App() {
  // client-side router library は追加しない。pathname だけで分岐する。
  const match = window.location.pathname.match(/^\/projects\/([^/]+)\/?$/)
  if (match !== null && match[1] !== undefined) {
    return <ProjectDetailPage projectId={decodeURIComponent(match[1])} />
  }
  return <DashboardPage />
}
