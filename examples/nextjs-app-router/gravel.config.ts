import { defineConfig } from '@artanis-ai/gravel'

export const config = defineConfig({
  mountPath: '/admin/ai',
  database: {
    url: process.env.DATABASE_URL!,
  },
  auth: {
    // Replace with `getUser` once your auth is wired up.
    defaultPassword: process.env.GRAVEL_ADMIN_PASSWORD!,
  },
})
