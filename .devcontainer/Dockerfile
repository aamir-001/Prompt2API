FROM mcr.microsoft.com/devcontainers/rust:1-1-bookworm

ARG SUBSTREAMS_VERSION=1.22.0
ARG BUF_VERSION=1.72.0

USER root

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        jq \
        postgresql-client \
        protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) substreams_arch="x86_64" ;; \
        arm64) substreams_arch="arm64" ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    substreams_asset="substreams_linux_${substreams_arch}.tar.gz"; \
    release_url="https://github.com/streamingfast/substreams/releases/download/v${SUBSTREAMS_VERSION}"; \
    curl --fail --show-error --silent --location \
        "${release_url}/${substreams_asset}" \
        --output "/tmp/${substreams_asset}"; \
    curl --fail --show-error --silent --location \
        "${release_url}/checksums.txt" \
        --output /tmp/substreams-checksums.txt; \
    expected_hash="$(awk -v asset="${substreams_asset}" '$2 == asset || $2 == "*" asset { print $1; exit }' /tmp/substreams-checksums.txt)"; \
    test -n "${expected_hash}"; \
    actual_hash="$(sha256sum "/tmp/${substreams_asset}" | awk '{ print $1 }')"; \
    test "${actual_hash}" = "${expected_hash}"; \
    tar --extract --gzip --file "/tmp/${substreams_asset}" --directory /tmp; \
    install --mode 0755 /tmp/substreams /usr/local/bin/substreams; \
    rm -f "/tmp/${substreams_asset}" /tmp/substreams-checksums.txt /tmp/substreams

RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) buf_arch="x86_64" ;; \
        arm64) buf_arch="aarch64" ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    buf_asset="buf-Linux-${buf_arch}"; \
    release_url="https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}"; \
    curl --fail --show-error --silent --location \
        "${release_url}/${buf_asset}" \
        --output "/tmp/${buf_asset}"; \
    curl --fail --show-error --silent --location \
        "${release_url}/sha256.txt" \
        --output /tmp/buf-checksums.txt; \
    expected_hash="$(awk -v asset="${buf_asset}" '$2 == asset || $2 == "*" asset { print $1; exit }' /tmp/buf-checksums.txt)"; \
    test -n "${expected_hash}"; \
    actual_hash="$(sha256sum "/tmp/${buf_asset}" | awk '{ print $1 }')"; \
    test "${actual_hash}" = "${expected_hash}"; \
    install --mode 0755 "/tmp/${buf_asset}" /usr/local/bin/buf; \
    rm -f "/tmp/${buf_asset}" /tmp/buf-checksums.txt

USER vscode

