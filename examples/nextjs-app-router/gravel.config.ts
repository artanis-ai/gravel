import { defineConfig } from '@artanis-ai/gravel'

export const config = defineConfig({
  mountPath: '/admin/ai',
  database: {
    url: process.env.DATABASE_URL!,
  },
  auth: {
    // Swap to `getUser: async (req) => ({ id, firstName, role: 'admin'|'user' })` once you wire your existing auth callback. Until then this default-password mode logs in anyone with the env-supplied password.
    defaultPassword: process.env.GRAVEL_ADMIN_PASSWORD!,
  },
})
