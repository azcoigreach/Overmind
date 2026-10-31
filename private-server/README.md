# Private Screeps development server

This stack builds [our launcher fork](https://github.com/azcoigreach/screeps-launcher)
at revision `7153153bb930ccaca616de70f9bee948845abfa2`. It adapts the fork's
Compose setup: Screeps, MongoDB 8.3.11, Redis 7, and persistent named volumes.
The runtime base is Bookworm, and `nodeVersion: Jod` selects Node 22 instead
of the fork's Node 12 default. Screeps is pinned to 4.3.0; Node patch releases
and mod dependencies are not locked. Container startup, world initialization,
and advancing game ticks were verified locally on October 12, 2026. Overmind
deployment and gameplay validation are still pending. The local world is already
initialized; the initialization instructions below are for a new installation.

MongoDB uses `GLIBC_TUNABLES=glibc.pthread.rseq=1` inside its container to avoid
the TCMalloc/kernel startup incompatibility on this Ubuntu host. This does not
change host settings. Reassess the setting when upgrading to a release with
[SERVER-131779](https://jira.mongodb.org/browse/SERVER-131779) fixed.

## Start the server

Prerequisites: Docker Engine with Compose v2, internet access for the image
build and first-launch dependencies, and a Steam Web API key.

From `Overmind/private-server/`:

```sh
cp -n .env.example .env
# Edit .env locally and set STEAM_KEY. Do not commit or paste the key into chat.
docker compose config --quiet
docker compose up -d --build
docker compose logs -f screeps
```

The first launch installs Node, Screeps, and mods and may take several minutes.
The server listens at `127.0.0.1:21025`. MongoDB, Redis, and the administrative
CLI are not published to the host. Change `SCREEPS_PORT` in `.env` if necessary.

For a **new, empty world only**, open the CLI after the backend starts:

```sh
docker compose exec screeps screeps-launcher cli
```

Run `system.resetAllData()` once to initialize the new database. This command
erases existing world data; do not use it on an established world. Exit with
Ctrl-D, then run `docker compose restart screeps`.

Check `docker compose ps` and `curl --fail http://127.0.0.1:21025/api/version`.
For child-process errors, inspect logs inside the container:
`docker compose exec screeps sh -c 'tail -n 60 logs/*.log'`.

## Connect and deploy Overmind

1. Connect the Steam client to the private server at `127.0.0.1:21025`, create
   your account, and place your initial spawn.
2. Set an API password through `http://127.0.0.1:21025/authmod/password/`, or
   run `auth.setPassword('YOUR_USERNAME', 'YOUR_PASSWORD')` in the server CLI.
3. Copy `screeps.local.example.json` to `../screeps.json` if that file does not
   exist. If it exists, update only its `pserver` entry. Enter your private
   username and password and match the port to `.env`. This file is Git-ignored.
4. From `Overmind/`, run `npm test`, then `npm run push-pserver`. Select the
   uploaded `main` branch in the private client. Confirm ticks advance and
   the bot spawns creeps without recurring console errors.

Use `docker compose stop` to pause the stack, `docker compose start` to resume,
and `docker compose down` to remove containers while preserving volumes.
`docker compose down --volumes` deletes the world and must not be used for
routine shutdown. Keep public-server deployment targets out of this workflow.

## Overmind-RL integration boundary

Overmind-RL is authorized for work with this private environment, but is not
yet included as a working Compose service. Its Python interface starts a
separate Node RPC backend, which owns, resets, and manually steps its own
Screeps processes. It does not attach to this continuously running world.

The existing training backend uses game port `21025 + 5 * worker_index` and
RPC port `22025 + 5 * worker_index`. A future training container must have
separate storage and publish its game port on a different host port, such as
`21125`, so worker zero cannot collide with this server. Keep training RPC
private. Its legacy Screeps 3.x and ZeroRPC dependencies require build and
reset/step testing before treating it as compatible with the modern server.
The existing `bots/overmind.js` is a training bundle; do not replace it with
the ordinary colony bundle without checking RL mode and action-segment support.
