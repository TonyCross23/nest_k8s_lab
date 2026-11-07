import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { createTodoSchema, updateTodoSchema, todoIdSchema } from './dto/todo.schema';
import type { CreateTodoDto, UpdateTodoDto } from './dto/todo.schema';
import { TodosService } from './todos.service';

@Controller('todos')
export class TodosController {
  constructor(private readonly todos: TodosService) {}

  @Post()
  create(@Body(new ZodValidationPipe(createTodoSchema)) body: CreateTodoDto) {
    return this.todos.create(body);
  }

  @Get()
  findAll() {
    return this.todos.findAll();
  }

  @Get(':id')
  findOne(@Param('id', new ZodValidationPipe(todoIdSchema)) id: number) {
    return this.todos.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', new ZodValidationPipe(todoIdSchema)) id: number,
    @Body(new ZodValidationPipe(updateTodoSchema)) body: UpdateTodoDto,
  ) {
    return this.todos.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ZodValidationPipe(todoIdSchema)) id: number) {
    await this.todos.remove(id);
  }
}
