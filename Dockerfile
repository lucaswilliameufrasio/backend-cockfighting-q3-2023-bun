FROM oven/bun as builder

WORKDIR /app

COPY package.json .
COPY bun.lockb .

RUN bun install --production

FROM gcr.io/distroless/base

WORKDIR /app

COPY --from=builder /usr/local/bin/bun bun
COPY --from=builder /app/node_modules node_modules

COPY src src

CMD ["./bun", "run", "src/index.ts"]
