import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export const getDb = (env: CloudflareBindings) => drizzle(env.DB, { schema })

export type Db = ReturnType<typeof getDb>
