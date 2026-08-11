# syntax=docker/dockerfile:1.7
# Production inputs are supplied by policy.json. The OCI platform manifest,
# Alpine repository indexes, npm tarball, and npm security overlays are all
# digest-pinned. No tag or unverified package index participates in the build.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS common

ARG APK_MAIN_REPOSITORY
ARG APK_COMMUNITY_REPOSITORY
ARG APK_MAIN_INDEX_SHA256
ARG APK_COMMUNITY_INDEX_SHA256
ARG COMMON_PACKAGES
ARG NODE_VERSION
ARG NPM_VERSION
ARG NPM_TARBALL_URL
ARG NPM_TARBALL_SHA256
ARG BRACE_EXPANSION_VERSION
ARG BRACE_EXPANSION_URL
ARG BRACE_EXPANSION_SHA256
ARG IP_ADDRESS_VERSION
ARG IP_ADDRESS_URL
ARG IP_ADDRESS_SHA256
ARG PIP_VERSION
ARG PIP_WHEEL_URL
ARG PIP_WHEEL_SHA256
ARG SETUPTOOLS_VERSION
ARG SETUPTOOLS_WHEEL_URL
ARG SETUPTOOLS_WHEEL_SHA256
ARG PIP_VENDOR_MSGPACK_VERSION
ARG PIP_VENDOR_MSGPACK_URL
ARG PIP_VENDOR_MSGPACK_SHA256
ARG PIP_VENDOR_SETUPTOOLS_VERSION
ARG PIP_VENDOR_SETUPTOOLS_URL
ARG PIP_VENDOR_SETUPTOOLS_SHA256

COPY --chmod=0555 apply-python-runtime-overlays.py /usr/local/libexec/apply-python-runtime-overlays.py

RUN set -eu; \
    test -n "$APK_MAIN_REPOSITORY"; \
    test -n "$APK_COMMUNITY_REPOSITORY"; \
    test -n "$APK_MAIN_INDEX_SHA256"; \
    test -n "$APK_COMMUNITY_INDEX_SHA256"; \
    printf '%s\n' "$APK_MAIN_REPOSITORY" "$APK_COMMUNITY_REPOSITORY" > /etc/apk/repositories; \
    apk update; \
    actual_indexes="$(sha256sum /var/cache/apk/APKINDEX.*.tar.gz | awk '{print $1}' | sort)"; \
    expected_indexes="$(printf '%s\n%s\n' "$APK_MAIN_INDEX_SHA256" "$APK_COMMUNITY_INDEX_SHA256" | sort)"; \
    test "$actual_indexes" = "$expected_indexes"; \
    apk upgrade --available; \
    apk add ${COMMON_PACKAGES}; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    git --version >/dev/null; \
    curl --version >/dev/null; \
    test -x /bin/sh; \
    curl --fail --location --proto '=https' --tlsv1.2 "$PIP_WHEEL_URL" --output /tmp/pip.whl; \
    echo "$PIP_WHEEL_SHA256  /tmp/pip.whl" | sha256sum -c -; \
    curl --fail --location --proto '=https' --tlsv1.2 "$SETUPTOOLS_WHEEL_URL" --output /tmp/setuptools.whl; \
    echo "$SETUPTOOLS_WHEEL_SHA256  /tmp/setuptools.whl" | sha256sum -c -; \
    curl --fail --location --proto '=https' --tlsv1.2 "$PIP_VENDOR_MSGPACK_URL" --output /tmp/pip-vendor-msgpack.tar.gz; \
    echo "$PIP_VENDOR_MSGPACK_SHA256  /tmp/pip-vendor-msgpack.tar.gz" | sha256sum -c -; \
    curl --fail --location --proto '=https' --tlsv1.2 "$PIP_VENDOR_SETUPTOOLS_URL" --output /tmp/pip-vendor-setuptools.whl; \
    echo "$PIP_VENDOR_SETUPTOOLS_SHA256  /tmp/pip-vendor-setuptools.whl" | sha256sum -c -; \
    python_site="/usr/lib/python$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')/site-packages"; \
    install -d -m 0755 "$python_site"; \
    python3 -m zipfile -e /tmp/pip.whl "$python_site"; \
    python3 -m zipfile -e /tmp/setuptools.whl "$python_site"; \
    python3 /usr/local/libexec/apply-python-runtime-overlays.py \
      --site-packages "$python_site" \
      --msgpack-archive /tmp/pip-vendor-msgpack.tar.gz \
      --msgpack-version "$PIP_VENDOR_MSGPACK_VERSION" \
      --setuptools-wheel /tmp/pip-vendor-setuptools.whl \
      --setuptools-version "$PIP_VENDOR_SETUPTOOLS_VERSION"; \
    printf '%s\n' '#!/bin/sh' 'exec python3 -m pip "$@"' > /usr/local/bin/pip; \
    chmod 0755 /usr/local/bin/pip; \
    ln -s pip /usr/local/bin/pip3; \
    test "$(PYTHONDONTWRITEBYTECODE=1 python3 -c 'import importlib.metadata; print(importlib.metadata.version("pip"))')" = "$PIP_VERSION"; \
    test "$(PYTHONDONTWRITEBYTECODE=1 python3 -c 'import importlib.metadata; print(importlib.metadata.version("setuptools"))')" = "$SETUPTOOLS_VERSION"; \
    test "$(PYTHONDONTWRITEBYTECODE=1 python3 -c 'from pip._vendor import msgpack; print(".".join(map(str, msgpack.version)))')" = "$PIP_VENDOR_MSGPACK_VERSION"; \
    PYTHONDONTWRITEBYTECODE=1 python3 -c 'from pip._vendor import pkg_resources' 2>/dev/null; \
    PYTHONDONTWRITEBYTECODE=1 python3 -m pip debug --verbose >/dev/null; \
    jq -e --arg msgpack "$PIP_VENDOR_MSGPACK_VERSION" --arg setuptools "$PIP_VENDOR_SETUPTOOLS_VERSION" \
      '([.components[] | select(.name == "msgpack") | .version] == [$msgpack]) and \
       ([.components[] | select(.name == "setuptools") | .version] == [$setuptools])' \
      "$python_site/pip/_vendor/bom.cdx.json" >/dev/null; \
    curl --fail --location --proto '=https' --tlsv1.2 "$NPM_TARBALL_URL" --output /tmp/npm.tgz; \
    echo "$NPM_TARBALL_SHA256  /tmp/npm.tgz" | sha256sum -c -; \
    mkdir /tmp/npm; \
    tar -xzf /tmp/npm.tgz -C /tmp/npm --strip-components=1; \
    test "$(jq -r .version /tmp/npm/package.json)" = "$NPM_VERSION"; \
    rm -rf /usr/local/lib/node_modules/npm; \
    mv /tmp/npm /usr/local/lib/node_modules/npm; \
    curl --fail --location --proto '=https' --tlsv1.2 "$BRACE_EXPANSION_URL" --output /tmp/brace-expansion.tgz; \
    echo "$BRACE_EXPANSION_SHA256  /tmp/brace-expansion.tgz" | sha256sum -c -; \
    mkdir /tmp/brace-expansion; \
    tar -xzf /tmp/brace-expansion.tgz -C /tmp/brace-expansion --strip-components=1; \
    test "$(jq -r .name /tmp/brace-expansion/package.json)" = brace-expansion; \
    test "$(jq -r .version /tmp/brace-expansion/package.json)" = "$BRACE_EXPANSION_VERSION"; \
    rm -rf /usr/local/lib/node_modules/npm/node_modules/brace-expansion; \
    mv /tmp/brace-expansion /usr/local/lib/node_modules/npm/node_modules/brace-expansion; \
    curl --fail --location --proto '=https' --tlsv1.2 "$IP_ADDRESS_URL" --output /tmp/ip-address.tgz; \
    echo "$IP_ADDRESS_SHA256  /tmp/ip-address.tgz" | sha256sum -c -; \
    mkdir /tmp/ip-address; \
    tar -xzf /tmp/ip-address.tgz -C /tmp/ip-address --strip-components=1; \
    test "$(jq -r .name /tmp/ip-address/package.json)" = ip-address; \
    test "$(jq -r .version /tmp/ip-address/package.json)" = "$IP_ADDRESS_VERSION"; \
    rm -rf /usr/local/lib/node_modules/npm/node_modules/ip-address; \
    mv /tmp/ip-address /usr/local/lib/node_modules/npm/node_modules/ip-address; \
    test "$(npm --version)" = "$NPM_VERSION"; \
    test "$(jq -r .version /usr/local/lib/node_modules/npm/node_modules/tar/package.json)" = 7.5.19; \
    test "$(jq -r .version /usr/local/lib/node_modules/npm/node_modules/undici/package.json)" = 6.27.0; \
    rm -rf /root/.npm /var/cache/misc/* /var/log/* /tmp/* /var/tmp/*; \
    rm -f /usr/local/libexec/apply-python-runtime-overlays.py; \
    rm -f /etc/machine-id; \
    : > /etc/machine-id

FROM common AS python
RUN rm -rf /var/cache/apk/*

FROM common AS desktop
ARG DESKTOP_PACKAGES
RUN set -eu; \
    printf '%032d\n' 0 > /etc/machine-id; \
    apk add ${DESKTOP_PACKAGES}; \
    command -v Xvfb >/dev/null; \
    command -v openbox >/dev/null; \
    command -v x11vnc >/dev/null; \
    command -v chromium >/dev/null; \
    command -v socat >/dev/null; \
    rm -rf /var/cache/apk/* /var/cache/misc/* /var/log/* /tmp/* /var/tmp/*; \
    rm -f /etc/machine-id; \
    : > /etc/machine-id
