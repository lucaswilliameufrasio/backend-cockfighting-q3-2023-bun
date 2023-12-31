setup:
	$ bun install
PHONY: setup

run:
	$ ENV=production bun run start
PHONY: run

build-image:
	# $ docker build -t lucaswilliameufrasio/backend-cockfighting-bun-api --progress=plain .
	$ docker build --no-cache -t lucaswilliameufrasio/backend-cockfighting-bun-api --progress=plain -f ./Dockerfile .
PHONY: build-image

start-database:
	$ docker compose -f docker-compose.dev.yml up -d postgres dragonfly
PHONY: start-database

stop-all-compose-services:
	$ docker compose -f docker-compose.dev.yml down
	$ docker volume rm backend-cockfighintg-q3-2023_postgres_data
PHONY: stop-all-compose-services

run-container:
	$ docker run --rm --name backend-cockfighting-bun-api --env-file=.env -p 9999:9999 lucaswilliameufrasio/backend-cockfighting-bun-api
PHONY: run-container

stop-container:
	$ docker stop backend-cockfighting-bun-api
PHONY: stop-container

push-image:
	$ docker push lucaswilliameufrasio/backend-cockfighting-bun-api
PHONY: push-image

