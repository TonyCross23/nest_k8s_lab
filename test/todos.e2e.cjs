const { test } = require('node:test');
const assert = require('node:assert/strict');

// Run against a running API backed by a disposable test database.
const base = (process.env.TEST_API_URL || 'http://localhost:3000').replace(/\/$/, '');

async function request(path = '', method = 'GET', body) {
  return fetch(`${base}/api/todos${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('Todo CRUD, validation, and missing records with real PostgreSQL', async () => {
  for (const body of [
    {}, { title: '   ' }, { title: 123 }, { title: 'x'.repeat(201) },
    { title: 'Test', completed: 'false' }, { title: 'Test', unknown: true },
    { title: 'Test', description: 'x'.repeat(2001) },
  ]) {
    const response = await request('', 'POST', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, 'Validation failed');
  }

  for (const id of ['abc', '0', '-1', '1.5', '2147483648']) {
    assert.equal((await request(`/${id}`)).status, 400);
  }

  const created = await request('', 'POST', { title: '  Learn NestJS  ', description: 'CRUD test' });
  assert.equal(created.status, 201);
  const todo = await created.json();

  try {
    assert.equal(todo.title, 'Learn NestJS');
    assert.equal(todo.completed, false);
    assert.ok(todo.createdAt);
    assert.ok(todo.updatedAt);

    const list = await request();
    assert.equal(list.status, 200);
    assert.ok((await list.json()).some((item) => item.id === todo.id));
    const detail = await request(`/${todo.id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).id, todo.id);

    for (const body of [{}, { unknown: true }, { title: '' }, { completed: 'true' }]) {
      assert.equal((await request(`/${todo.id}`, 'PATCH', body)).status, 400);
    }

    const updated = await request(`/${todo.id}`, 'PATCH', { completed: true, description: null });
    assert.equal(updated.status, 200);
    const result = await updated.json();
    assert.equal(result.completed, true);
    assert.equal(result.description, null);
    assert.equal(result.title, todo.title);

    const deleted = await request(`/${todo.id}`, 'DELETE');
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '');
    assert.equal((await request(`/${todo.id}`)).status, 404);
    assert.equal((await request(`/${todo.id}`, 'PATCH', { completed: false })).status, 404);
    assert.equal((await request(`/${todo.id}`, 'DELETE')).status, 404);
  } finally {
    await request(`/${todo.id}`, 'DELETE');
  }
});
