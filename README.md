# NestJS Todo CRUD

ရိုးရိုး Todo REST API — NestJS, Zod validation, PostgreSQL, Prisma, Docker နဲ့ Docker Compose သုံးထားပါတယ်။

## Docker နဲ့ run မယ်

Docker နဲ့ Docker Compose လိုအပ်ပါတယ်။

```bash
docker compose up --build -d
docker compose ps -a
docker compose logs -f api
```

API: `http://localhost:3000/api/todos`

Compose က PostgreSQL healthy ဖြစ်တဲ့အထိစောင့်ပြီး migration အောင်မြင်မှ API ကို စပေးပါတယ်။ `.env` မဖန်တီးဘဲ Docker နဲ့ တန်း run လို့ရပါတယ်။ `migrate` service မှာ `Exited (0)` ပြတာ ပုံမှန်ပါ။

```bash
# Containers တွေပိတ်မယ်၊ database data ကို ဆက်သိမ်းထားမယ်
docker compose down

# Database data အားလုံးပါ ဖျက်မယ် — ပြန်ယူလို့မရပါ
docker compose down -v
```

ဒီ credentials တွေက local learning အတွက်ပါ။ Public server မှာ deploy မလုပ်ခင် credentials ပြောင်းပြီး authentication ထည့်ပါ။

## Local development

Node.js 24.15+ နဲ့ npm သုံးဖို့ အကြံပြုပါတယ်။ PostgreSQL ကို Docker နဲ့ run ပြီး API ကို local မှာ run နိုင်ပါတယ်။

```bash
cp .env.example .env
npm ci
docker compose up -d db
npm run prisma:generate
npm run db:deploy
npm run start:dev
```

Compose API ကို run ထားပြီးသားဆို port 3000 လွတ်ဖို့ `docker compose stop api` အရင် run ပါ။ Database ကို ကိုယ်တိုင် run ထားရင် `.env` ထဲက `DATABASE_URL` ကို ပြောင်းပါ။

Schema ပြင်ပြီး migration အသစ်လုပ်ဖို့:

```bash
npm run db:migrate -- --name describe_change
```

Migration SQL တွေကို project နဲ့အတူ commit လုပ်ထားပါ။ Prisma 7 အတွက် connection URL က `prisma.config.ts` ထဲမှာရှိပြီး runtime မှာ `@prisma/adapter-pg` သုံးထားပါတယ်။

## Endpoints

| Method | URL | လုပ်ဆောင်ချက် |
| --- | --- | --- |
| POST | `/api/todos` | Todo အသစ်ဖန်တီး |
| GET | `/api/todos` | အားလုံးကြည့်၊ အသစ်ဆုံးအရင်ပြ |
| GET | `/api/todos/:id` | တစ်ခုကြည့် |
| PATCH | `/api/todos/:id` | ပေးထားတဲ့ fields ပဲပြင် |
| DELETE | `/api/todos/:id` | ဖျက်၊ 204 ပြန် |

### Create

```bash
curl -i http://localhost:3000/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"title":"Learn NestJS","description":"Build a CRUD API"}'
```

### Read

```bash
curl http://localhost:3000/api/todos
curl http://localhost:3000/api/todos/1
```

### Update

```bash
curl -i -X PATCH http://localhost:3000/api/todos/1 \
  -H 'Content-Type: application/json' \
  -d '{"completed":true}'
```

`description` ကို ဖယ်ချင်ရင် `{"description":null}` ပို့နိုင်ပါတယ်။

### Delete

```bash
curl -i -X DELETE http://localhost:3000/api/todos/1
```

Create က ပြန်ပေးတဲ့ `id` ကို နောက် request တွေမှာသုံးပါ။

## Validation

- `title`: လိုအပ်ပါတယ်၊ trim လုပ်ပြီး စာလုံး 1–200 ရှိရပါမယ်။
- `description`: optional၊ အများဆုံး စာလုံး 2000၊ `null` ပေးနိုင်ပါတယ်။
- `completed`: optional boolean၊ default `false` ဖြစ်ပါတယ်။
- PATCH မှာ field အနည်းဆုံးတစ်ခု ပါရပါမယ်။
- မသတ်မှတ်ထားတဲ့ fields တွေကို 400 နဲ့ reject လုပ်ပါတယ်။
- ID က positive PostgreSQL integer ဖြစ်ရပါမယ်။ မမှန်ရင် 400၊ record မရှိရင် 404 ပြန်ပါတယ်။

Validation error နမူနာ:

```json
{
  "message": "Validation failed",
  "errors": [{ "path": "title", "message": "Too small: expected string to have >=1 characters" }]
}
```

## Verify

```bash
npm run build
# API နဲ့ PostgreSQL run ထားတဲ့အချိန်:
npm run test:e2e
```

Integration test က Todo တစ်ခုဖန်တီးပြီး CRUD၊ validation နဲ့ 404 responses တွေစစ်ကာ test data ကို ပြန်ဖျက်ပါတယ်။ Test database နဲ့ပဲ run ပါ။ တခြား port သုံးရင် `TEST_API_URL=http://localhost:3001 npm run test:e2e` သုံးနိုင်ပါတယ်။

## Structure

```text
src/
  main.ts
  app.module.ts
  config/env.ts
  common/pipes/zod-validation.pipe.ts
  prisma/                 # Database connection
  todos/                  # Controller, service, module, Zod schemas
prisma/
  schema.prisma
  migrations/
test/todos.e2e.cjs
Dockerfile
compose.yaml
```

Zod schemas ကို DTO type နဲ့ runtime validation နှစ်ခုစလုံးမှာသုံးထားပါတယ်။ Controller က HTTP requests လက်ခံပြီး service က Prisma နဲ့ database ကို ဆက်သွယ်ပါတယ်။

ကိုးကားရန်: [NestJS validation](https://docs.nestjs.com/validation), [Prisma 7 setup](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)။
