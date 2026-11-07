import 'dotenv/config';
import { z } from 'zod';

export const env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().refine(
    (url) => ['postgres:', 'postgresql:'].includes(new URL(url).protocol),
    'DATABASE_URL must be a PostgreSQL connection URL',
  ),
}).parse(process.env);
