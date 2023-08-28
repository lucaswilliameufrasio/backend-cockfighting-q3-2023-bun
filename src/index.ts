import { Elysia, t } from 'elysia'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import Redis from 'ioredis'

const sql = postgres({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  idle_timeout: 240,
  max: process.env.DB_MAX_CONNECTIONS
    ? Number(process.env.DB_MAX_CONNECTIONS)
    : 90,
  connection: {
    application_name: 'cockfighting-bun-api',
  },
})

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379/1')

new Elysia()
  .get('/health-check', () => ({ message: 'ok' }))
  .post(
    '/pessoas',
    async (context) => {
      const personAlreadyExists = await redis.exists(context.body.apelido)

      if (personAlreadyExists) {
        context.set.status = 422
        return { message: 'Internal Server Error' }
      }

      const uuid = uuidv7()
      await redis.set(uuid, JSON.stringify({
        id: uuid,
        apelido: context.body.apelido,
        nome: context.body.nome,
        nascimento: context.body.nascimento,
        stack: context.body.stack
      }))
      
      await redis.expire(uuid, 90)
      
      const stacks = context.body.stack?.join(',') ?? ''
      const [result] = await sql`
        INSERT INTO people (id, nickname, name, birth_date, stack)
        VALUES (${uuid}, ${context.body.apelido}, ${context.body.nome}, ${
        context.body.nascimento
      }, ${stacks})
        ON CONFLICT DO NOTHING
        RETURNING id;
        `

      if (!result) {
        context.set.status = 422
        return { message: 'Person already exists' }
      }

      const id = result.id

      await redis.set(context.body.apelido, 1)
      await redis.expire(context.body.apelido, 90)

      context.set.headers['Location'] = `/pessoas/${result.id}`
      context.set.status = 201
      return { id }
    },
    {
      body: t.Object({
        apelido: t.String({
          minLength: 1,
          maxLength: 32,
        }),
        nome: t.String({
          minLength: 1,
          maxLength: 100,
        }),
        nascimento: t.RegExp(
          /^\d{4}\-(0[1-9]|1[012])\-(0[1-9]|[12][0-9]|3[01])$/,
          {
            default: '',
          },
        ),
        stack: t.Optional(t.Array(t.String(), {
          minItems: 1,
        })),
      }),
      onResponse: () => {},
    },
  )
  .get(
    '/pessoas/:id',
    async (context) => {
      if (!context.params.id || context.params.id.length !== 36) {
        context.set.status = 404
        return {
          message: 'This person do not exist',
        }
      }

      const id = context.params.id

      const cachedPerson = await redis.get(id)

      if (cachedPerson) {
        return JSON.parse(cachedPerson)
      }

      const [personFound] =
        await sql`SELECT people.id, people.nickname, people.name, people.birth_date, people.stack FROM people WHERE people.id = ${id};`

      if (!personFound) {
        context.set.status = 404
        return {
          message: 'This person do not exist',
        }
      }

      const result = {
        id: personFound.id,
        apelido: personFound.nickname,
        nome: personFound.name,
        nascimento: personFound.birth_date,
        stack: personFound.stack.split(','),
      }


      await redis.set(id, JSON.stringify(result))

      await redis.expire(id, 90)

      return result
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    },
  )
  .get(
    '/pessoas',
    async (context) => {
      if (!context.query.t || context.query.t.length === 0) {
        context.set.status = 400
        return {
          message: "The query parameter 't' is required",
        }
      }

      const result =
        await sql`SELECT people.id, people.nickname, people.name, people.birth_date, people.stack FROM people WHERE LOWER(people.name || ' ' || people.nickname || ' ' || people.stack) LIKE LOWER(${`%${context.query.t}%`}) LIMIT 50;`

      if (!result.length) {
        context.set.status = 200
        return []
      }

      return result.map((person) => ({
        id: person.id,
        apelido: person.nickname,
        nome: person.name,
        nascimento: person.birth_date,
        stack: person.stack.split(','),
      }))
    },
    {
      query: t.Object({
        t: t.String(),
      }),
    },
  )
  .get('/contagem-pessoas', async () => {
    const [result] = await sql`SELECT COUNT(*) AS count FROM people;`

    if (!result) {
      return {
        count: 0,
      }
    }

    return {
      count: Number(result.count),
    }
  })
  .onError(({ code, error, set }) => {
    if (code === 'UNKNOWN' || code === 'VALIDATION') {
      set.status = 422
      return { message: error.message }
    }

    if (code === 'NOT_FOUND') {
      set.status = 404
      return { message: error.message }
    }

    set.status = 500
    return { message: 'Internal Server Error' }
  })
  .listen({
    hostname: '0.0.0.0',
    port: `${process.env.PORT ?? 9999}`
  }, ({ hostname, port }) => {
    console.log(`Running at http://${hostname}:${port}`)
})
