import { z } from 'zod';

export const createTodoSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  completed: z.boolean().optional(),
});

export const updateTodoSchema = createTodoSchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  'Provide at least one field to update',
);

export const todoIdSchema = z.coerce.number().int().positive().max(2147483647);

export type CreateTodoDto = z.infer<typeof createTodoSchema>;
export type UpdateTodoDto = z.infer<typeof updateTodoSchema>;
