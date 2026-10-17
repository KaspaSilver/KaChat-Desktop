# Reproducible build of kaspa/kaspa.js + kaspa/kaspa_bg.wasm (the rusty-kaspa WASM SDK, web target)
# from a pinned rusty-kaspa commit - audit findings DSK-005 / EXT-014. Run it through
# tools/build-kaspa-wasm.sh, which passes the pins below and checks the result against kaspa/SHA256SUMS.
#
# The original binary embeds absolute paths from its build host (rustup toolchain and cargo registry
# under /home/shudan), so the same user, home and toolchain directory name are recreated here: with
# the same commit, rustc, wasm-pack and paths the output is byte-identical.
FROM --platform=linux/amd64 debian:bookworm-slim

ARG RUST_VERSION=1.95.0
ARG WASM_PACK_VERSION=0.15.0
ARG RUSTY_KASPA_COMMIT
# The checkout's directory name: Cargo hashes each path package's absolute location into its
# symbol names, which moves functions around in the output, so it has to match the original host.
ARG SRC_DIR=rusty-kaspa-master

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git build-essential pkg-config clang llvm libssl-dev \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --home-dir /home/shudan shudan
USER shudan
ENV HOME=/home/shudan
WORKDIR /home/shudan

# rustup with the pinned release, then named "stable" like the original host's toolchain directory.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION} --no-modify-path \
 && . "$HOME/.cargo/env" \
 && rustup target add wasm32-unknown-unknown --toolchain ${RUST_VERSION} \
 && rustup component add rust-src --toolchain ${RUST_VERSION} \
 && mv "$HOME/.rustup/toolchains/${RUST_VERSION}-x86_64-unknown-linux-gnu" "$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu" \
 && rustup default stable \
 && rustc --version --verbose
ENV PATH=/home/shudan/.cargo/bin:$PATH

RUN cargo install wasm-pack --version ${WASM_PACK_VERSION} --locked && wasm-pack --version

RUN test -n "${RUSTY_KASPA_COMMIT}" \
 && git init ${SRC_DIR} && cd ${SRC_DIR} \
 && git remote add origin https://github.com/kaspanet/rusty-kaspa.git \
 && git fetch --depth 1 origin ${RUSTY_KASPA_COMMIT} \
 && git checkout --detach FETCH_HEAD \
 && git log -1 --format='%H %cI %s'

WORKDIR /home/shudan/${SRC_DIR}/wasm
RUN ./build-web --sdk && sha256sum web/kaspa/kaspa_bg.wasm web/kaspa/kaspa.js
