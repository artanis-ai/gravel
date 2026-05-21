import { Router, Route, Switch } from 'wouter'
import { useApi } from './lib/api'
import { Layout } from './components/Layout'
import { PromptsPage } from './routes/Prompts'
import { SamplesPage } from './routes/Samples'
import { LoadingPage } from './components/LoadingPage'
import { LoginPage } from './routes/Login'
import { Toaster } from './components/Toast'

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
          <Route path="/samples" component={() => <SamplesPage />} />
          <Route path="/samples/:id">{(params) => <SamplesPage sampleId={params.id} />}</Route>
        </Switch>
      </Layout>
      <Toaster />
    </Router>
  )
}
