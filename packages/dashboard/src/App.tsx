import { Router, Route, Switch } from 'wouter'
import { useApi } from './lib/api'
import { Layout } from './components/Layout'
import { PromptsPage } from './routes/Prompts'
import { TracesPage } from './routes/Traces'
import { DatasetsPage } from './routes/Datasets'
import { EvalsPage } from './routes/Evals'
import { ReviewPage } from './routes/Review'
import { LoadingPage } from './components/LoadingPage'
import { LoginPage } from './routes/Login'

export function App() {
  const { data: me, isLoading, error } = useApi.get('/api/auth/me')

  if (isLoading) return <LoadingPage />
  if (error) return <LoginPage />

  // The SDK injects window.__GRAVEL_MOUNT_PATH__ into the shell HTML
  // (handler/routes.ts → rewriteShell). Wouter uses it as the base so
  // `<Route path="/">` matches the dashboard root regardless of mount.
  const base =
    (window as unknown as { __GRAVEL_MOUNT_PATH__?: string }).__GRAVEL_MOUNT_PATH__ ?? ''

  return (
    <Router base={base}>
      <Layout user={me?.user}>
        <Switch>
          <Route path="/" component={() => <PromptsPage />} />
          <Route path="/prompts" component={() => <PromptsPage />} />
          <Route path="/prompts/:id">{(params) => <PromptsPage promptId={params.id} />}</Route>
          <Route path="/traces" component={() => <TracesPage />} />
          <Route path="/traces/:id">{(params) => <TracesPage traceId={params.id} />}</Route>
          <Route path="/review" component={() => <ReviewPage />} />
          {/* Legacy direct links — folded into /review for nav, kept routable so
              bookmarks + the existing detail pages still work. */}
          <Route path="/datasets" component={() => <DatasetsPage />} />
          <Route path="/datasets/:id">{(params) => <DatasetsPage datasetId={params.id} />}</Route>
          <Route path="/evals" component={() => <EvalsPage />} />
          <Route path="/evals/:id">{(params) => <EvalsPage runId={params.id} />}</Route>
        </Switch>
      </Layout>
    </Router>
  )
}
