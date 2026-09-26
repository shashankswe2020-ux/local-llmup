# syntax=docker/dockerfile:1
FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e AS build

WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
COPY vendor ./vendor
RUN cargo build --release --locked -p llmup-cli --bin llmup --bin local-llmup -p llmup-gui --bin llmup-gui

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates lsof procps \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system llmup \
    && useradd --system --gid llmup --create-home --home-dir /home/llmup llmup

COPY --from=build /app/target/release/llmup /usr/local/bin/llmup
COPY --from=build /app/target/release/local-llmup /usr/local/bin/local-llmup
COPY --from=build /app/target/release/llmup-gui /usr/local/bin/llmup-gui
COPY LICENSE crates/llmup-gui/vendor/README.md crates/llmup-gui/vendor/marked.LICENSE.md crates/llmup-gui/vendor/dompurify.LICENSE /usr/share/doc/local-llmup/
COPY vendor/crossterm/LICENSE /usr/share/doc/local-llmup/crossterm.LICENSE
COPY vendor/crossterm/LLMUP-PATCH.md /usr/share/doc/local-llmup/CROSSTERM-PATCH.md
ENV HOME=/home/llmup
ENV LOCAL_LLMUP_HOME=/home/llmup/.local-llmup

USER llmup
ENTRYPOINT ["/usr/local/bin/llmup"]
CMD ["recommend", "--json"]
