import { Elysia, t } from 'elysia'
import { uuidv7 } from 'uuidv7'
// import postgres from 'postgres'
import Redis from 'ioredis'
import { Pool } from 'pg'

// const sql = postgres({
//   host: process.env.DB_HOST,
//   port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
//   database: process.env.DB_NAME,
//   username: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   idle_timeout: 240,
//   max: process.env.DB_MAX_CONNECTIONS
//     ? Number(process.env.DB_MAX_CONNECTIONS)
//     : 90,
//   connection: {
//     application_name: 'cockfighting-bun-api',
//   },
// })

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: process.env.DB_MAX_CONNECTIONS
    ? Number(process.env.DB_MAX_CONNECTIONS)
    : 90,
  idleTimeoutMillis: 240000,
  connectionTimeoutMillis: 240000,
  application_name: 'cockfighting-bun-api',
})

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379/1')

function bootstrapSubscribers() {
  const subscriberRedis = new Redis(
    process.env.REDIS_URL ?? 'redis://localhost:6379/1',
  )
  const batchSize = Number(process.env.BATCH_SIZE ?? 10)

  const batchOfPeopleToCreate: Array<
    Array<{
      id: string
      apelido: string
      nome: string
      nascimento: string
      stack: Array<string>
    }>
  > = [[]]
  subscriberRedis.subscribe(
    'save-person-to-be-created',
    'create-person',
    (err, count) => {
      if (err) {
        console.error('Failed to subscribe: %s', err.message)
      } else {
        console.log(
          `Subscribed successfully! This client is currently subscribed to ${count} channels.`,
        )
      }
    },
  )

  subscriberRedis.on('message', async (channel, message) => {
    if (channel === 'create-person') {
      try {
        const messageParsed = JSON.parse(
          message,
        ) as (typeof batchOfPeopleToCreate)[0]

        const messagesWithoutUndefined = messageParsed.filter(
          (person) =>
            person.id &&
            person.apelido &&
            person.nome &&
            person.nascimento &&
            person.stack !== undefined,
        )

        const query = `INSERT INTO people (id, nickname, name, birth_date, stack) VALUES ${messagesWithoutUndefined.map(
          (_, index) =>
            `($${5 * index + 1}, $${5 * index + 2}, $${5 * index + 3}, $${
              5 * index + 4
            }, $${5 * index + 5})`,
        )} ON CONFLICT DO NOTHING;`

        const client = await pool.connect()

        await client.query(
          query,
          messagesWithoutUndefined.flatMap((message) => [
            message.id,
            message.apelido,
            message.nome,
            message.nascimento,
            message.stack,
          ]),
        )

        client.release()

        // await sql`INSERT INTO people ${sql(
        //   messageParsed
        //     .filter(
        //       (person) =>
        //         person.id &&
        //         person.apelido &&
        //         person.nome &&
        //         person.nascimento &&
        //         person.stack,
        //     )
        //     .map((person) => ({
        //       id: person.id,
        //       nickname: person.apelido,
        //       name: person.nome,
        //       birth_date: person.nascimento,
        //       stack: person.stack,
        //     })),
        // )} ON CONFLICT DO NOTHING;`
        return
      } catch (error) {
        // console.error('create failed', error, message)
        return
      }
    }

    const messageParsed = JSON.parse(message)
    messageParsed.stack = messageParsed.stack?.join(',') ?? ''

    if (
      batchOfPeopleToCreate[batchOfPeopleToCreate.length - 1].length < batchSize
    ) {
      batchOfPeopleToCreate[batchOfPeopleToCreate.length - 1].push(
        messageParsed,
      )
    } else {
      const peopleToCreate = batchOfPeopleToCreate.pop()
      batchOfPeopleToCreate.push([])
      batchOfPeopleToCreate[batchOfPeopleToCreate.length - 1].push(
        messageParsed,
      )

      if (!peopleToCreate) {
        return
      }

      await redis.publish('create-person', JSON.stringify(peopleToCreate))
    }
  })
}

new Elysia()
  .get('/health-check', () => ({ message: 'ok' }))
  .post(
    '/pessoas',
    async (context) => {
      try {
        const personAlreadyExists = await redis.exists(context.body.apelido)

        if (personAlreadyExists) {
          context.set.status = 422
          return { message: 'Person already exists' }
        }

        await redis.set(context.body.apelido, 1)
        await redis.expire(context.body.apelido, 90)

        const id = uuidv7()
        const person = JSON.stringify({
          id,
          apelido: context.body.apelido,
          nome: context.body.nome,
          nascimento: context.body.nascimento,
          stack: context.body.stack,
        })
        await redis.set(id, person)

        redis.publish('save-person-to-be-created', person)

        await redis.expire(id, 90)

        context.set.headers['Location'] = `/pessoas/${id}`
        context.set.status = 201
        return { id }
      } catch (error) {
        context.set.status = 500
        // console.error('createfailed', error, context.body)
        return { message: 'damn' }
      }
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
        stack: t.Optional(
          t.Array(t.String(), {
            default: [],
          }),
        ),
      }),
      onResponse: () => {},
    },
  )
  .get(
    '/pessoas/:id',
    async (context) => {
      try {
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

        const client = await pool.connect()

        const {
          rows: [personFound],
        } = await client.query(
          `SELECT people.id, people.nickname, people.name, people.birth_date, people.stack FROM people WHERE people.id = $1;`,
          [id],
        )

        client.release()

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
      } catch (error) {
        context.set.status = 500
        // console.error('find failed', error, context.params)
        return { message: 'damn' }
      }
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
      try {
        if (!context.query.t || context.query.t.length === 0) {
          context.set.status = 400
          return {
            message: "The query parameter 't' is required",
          }
        }

        const client = await pool.connect()

        const { rows: result } = await client.query(
          `SELECT people.id, people.nickname, people.name, people.birth_date, people.stack FROM people WHERE LOWER(people.name || ' ' || people.nickname || ' ' || people.stack) LIKE LOWER($1) LIMIT 50;`,
          [`%${context.query.t}%`],
        )
        client.release()

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
      } catch (error) {
        context.set.status = 500
        // console.error('load failed', error, context.query)
        return { message: 'damn' }
      }
    },
    {
      query: t.Object({
        t: t.String(),
      }),
    },
  )
  .get('/contagem-pessoas', async () => {
    const client = await pool.connect()

    const { rows: result } = await client.query(
      `SELECT COUNT(*) AS count FROM people;`,
    )

    client.release()

    if (!result) {
      return {
        count: 0,
      }
    }

    return {
      count: Number(result[0].count),
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
  .listen(
    {
      hostname: '0.0.0.0',
      port: `${process.env.PORT ?? 9999}`,
    },
    ({ hostname, port }) => {
      console.log(`Running at http://${hostname}:${port}`)
      if (process.env.REDIS_SUBSCRIBER === '1') {
        bootstrapSubscribers()
      }
    },
  )
