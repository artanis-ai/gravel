import { createGravelHandler } from '@artanis/gravel/next'
import { config } from '@/gravel.config'

const handler = createGravelHandler({ config })

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
