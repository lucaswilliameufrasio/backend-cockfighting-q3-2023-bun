FROM debian:12-slim as builder

WORKDIR /app

RUN apt-get update && apt-get install curl unzip -y

RUN curl https://bun.sh/install | bash

COPY package.json .
COPY bun.lockb .

RUN /root/.bun/bin/bun install --production

FROM gcr.io/distroless/base

WORKDIR /app

COPY --from=builder /root/.bun/bin/bun bun
COPY --from=builder /app/node_modules node_modules

COPY src src

ENV ENV production
CMD ["./bun", "src/index.ts"]
