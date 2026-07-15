FROM rust:1.97.0-bookworm AS builder
WORKDIR /source/workers
COPY workers/Cargo.toml workers/Cargo.lock ./
COPY workers/processing-sdk ./processing-sdk
COPY workers/latex ./latex
RUN cargo build --locked --release -p toss-latex-worker

FROM texlive/texlive@sha256:d39efa547acfa518072600315280f92357ca8e0b9e295e09b6ccd5f5d82a1373
LABEL org.opencontainers.image.title="TOSS Community LaTeX Worker"
LABEL org.opencontainers.image.description="Optional native TeX Live processor for latex.compile.pdf/v1"

RUN test "$(bwrap --version)" = 'bubblewrap 0.11.2' \
    && test -s /etc/ssl/certs/ca-certificates.crt \
    && command -v prlimit >/dev/null \
    && groupadd --gid 10001 toss-worker \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin toss-worker \
    && install -d -o 10001 -g 10001 /work /opt/toss/latex-worker \
    && install -m 0755 /usr/bin/bwrap /usr/local/bin/toss-bwrap

# Verify the immutable 2026 snapshot that defines the processor contract. The
# image already contains both formats, so the worker never mutates TEXMFSYSVAR.
RUN test "$(tlmgr --version | sed -n '1s/^tlmgr revision \([0-9][0-9]*\).*/\1/p')" = '79639' \
    && latexmk -version | grep -F 'Version 4.88' >/dev/null \
    && pdftex --version | grep -F 'pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)' >/dev/null \
    && xetex --version | grep -F 'XeTeX 3.141592653-2.6-0.999998 (TeX Live 2026)' >/dev/null \
    && printf '%s  %s\n' \
      '4df90e66ac87ff5b44722e4b248a609c286ff8083d9839ddfa7604b0b1f32cef' \
      '/usr/local/texlive/2026/tlpkg/texlive.tlpdb' \
      '40b93ba7582424dfad6179c5e110bc9d078c88546573578486c0c5304c29aa07' \
      '/usr/local/texlive/2026/texmf-dist/ls-R' \
      '82c707f596b1b8c09d2a85a59b1d2db13101eeecb7f62b9b29b2874f8039cc8c' \
      '/usr/local/texlive/2026/texmf-var/web2c/pdftex/pdflatex.fmt' \
      '8b7bbed161b8d73cbd64bd035476b816ced0df64736daae9a451da852b6af9ac' \
      '/usr/local/texlive/2026/texmf-var/web2c/xetex/xelatex.fmt' \
      | sha256sum --check --strict \
    && test "$(fc-list | LC_ALL=C sort | sha256sum | cut -d' ' -f1)" = \
      '0eebb68084c177be0ac74e10514395ec917d7c2d2b7c9a1f86df719d7705d7ec'

COPY --from=builder /source/workers/target/release/toss-latex-worker /usr/local/bin/toss-latex-worker
COPY --chmod=0444 workers/latex/latexmkrc /opt/toss/latex-worker/latexmkrc
COPY --chmod=0444 workers/latex/processor-contract.json /opt/toss/latex-worker/processor-contract.json

USER 10001:10001
WORKDIR /work
ENV TMPDIR=/work
ENV PROCESSING_LATEX_EXECUTOR=bubblewrap
ENV PROCESSING_LATEXMKRC=/opt/toss/latex-worker/latexmkrc
ENTRYPOINT ["/usr/local/bin/toss-latex-worker"]
