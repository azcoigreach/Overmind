FROM golang:1.24-bookworm AS launcher

# Build our fork at a known revision, rather than silently following upstream.
ARG LAUNCHER_REVISION=7153153bb930ccaca616de70f9bee948845abfa2
WORKDIR /src
RUN git init . \
    && git remote add origin https://github.com/azcoigreach/screeps-launcher.git \
    && git fetch --depth=1 origin "${LAUNCHER_REVISION}" \
    && git checkout --detach FETCH_HEAD \
    && CGO_ENABLED=0 go build -o /usr/local/bin/screeps-launcher ./cmd/screeps-launcher

# The fork's original Buster base is replaced with Bookworm. The launcher
# installs the Node version configured in config.yml into its data volume.
FROM buildpack-deps:bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python-is-python3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 screeps \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash screeps \
    && mkdir /screeps \
    && chown screeps:screeps /screeps
COPY --from=launcher /usr/local/bin/screeps-launcher /usr/local/bin/screeps-launcher
USER screeps
WORKDIR /screeps
ENTRYPOINT ["screeps-launcher"]
