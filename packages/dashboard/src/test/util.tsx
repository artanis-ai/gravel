import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderOptions } from '@testing-library/react'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'

export function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  })
}

export function renderRoute(
  ui: ReactNode,
  { path = '/', client = makeClient(), ...options }: { path?: string; client?: QueryClient } & Omit<RenderOptions, 'wrapper'> = {},
) {
  const { hook } = memoryLocation({ path })
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <Router hook={hook}>{children}</Router>
      </QueryClientProvider>
    )
  }
  return { ...render(ui, { wrapper: Wrapper, ...options }), client }
}
