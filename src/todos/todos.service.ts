import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTodoDto, UpdateTodoDto } from './dto/todo.schema';

@Injectable()
export class TodosService {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateTodoDto) {
    return this.prisma.todo.create({ data });
  }

  findAll() {
    return this.prisma.todo.findMany({ orderBy: { id: 'desc' } });
  }

  async findOne(id: number) {
    const todo = await this.prisma.todo.findUnique({ where: { id } });
    if (!todo) throw new NotFoundException(`Todo ${id} not found`);
    return todo;
  }

  async update(id: number, data: UpdateTodoDto) {
    try {
      return await this.prisma.todo.update({ where: { id }, data });
    } catch (error) {
      this.handleNotFound(error, id);
    }
  }

  async remove(id: number) {
    try {
      return await this.prisma.todo.delete({ where: { id } });
    } catch (error) {
      this.handleNotFound(error, id);
    }
  }

  private handleNotFound(error: unknown, id: number): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new NotFoundException(`Todo ${id} not found`);
    }
    throw error;
  }
}
