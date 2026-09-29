# syntax=docker/dockerfile:1
FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS build

WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY vendor ./vendor
RUN cargo build --release --locked -p rigspark-cli --bin llmup --bin rigspark -p rigspark-gui --bin rigspark-gui

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates lsof procps \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system llmup \
    && useradd --system --gid llmup --create-home --home-dir /home/llmup llmup

COPY --from=build /app/target/release/llmup /usr/local/bin/llmup
COPY --from=build /app/target/release/rigspark /usr/local/bin/rigspark
COPY --from=build /app/target/release/rigspark-gui /usr/local/bin/rigspark-gui
COPY LICENSE crates/rigspark-gui/vendor/README.md crates/rigspark-gui/vendor/marked.LICENSE.md crates/rigspark-gui/vendor/dompurify.LICENSE /usr/share/doc/rigspark/
COPY vendor/crossterm/LICENSE /usr/share/doc/rigspark/crossterm.LICENSE
COPY vendor/crossterm/RIGSPARK-PATCH.md /usr/share/doc/rigspark/CROSSTERM-PATCH.md
ENV HOME=/home/llmup
ENV RIGSPARK_HOME=/home/llmup/.rigspark

USER llmup
ENTRYPOINT ["/usr/local/bin/llmup"]
CMD ["recommend", "--json"]
