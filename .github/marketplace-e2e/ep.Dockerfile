FROM oven/bun:1.3.14

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 lvis \
    && useradd --create-home --uid 10001 --gid 10001 --shell /bin/bash lvis \
    && mkdir -p /workspace/lvis-plugin-lge-api /out \
    && chown -R 10001:10001 /workspace /out

COPY --chown=10001:10001 lvis-plugin-lge-api/ /workspace/lvis-plugin-lge-api/

ARG E2E_NONCE
ARG HOST_SHA
ARG MARKETPLACE_SHA
ARG SDK_SHA
ARG EP_API_SHA
LABEL org.lvis.marketplace-e2e.nonce="${E2E_NONCE}" \
      org.lvis.marketplace-e2e.host-sha="${HOST_SHA}" \
      org.lvis.marketplace-e2e.marketplace-sha="${MARKETPLACE_SHA}" \
      org.lvis.marketplace-e2e.sdk-sha="${SDK_SHA}" \
      org.lvis.marketplace-e2e.ep-api-sha="${EP_API_SHA}"

USER 10001:10001
ENV HOME=/home/lvis
WORKDIR /workspace/lvis-plugin-lge-api
RUN bun install --frozen-lockfile \
    && bun run build \
    && test -f dist/hostPlugin.js \
    && test -f dist/ui/lge-control.js \
    && zip -X -q -r "/out/lvis-plugin-ep-${EP_API_SHA}.zip" plugin.json dist skills \
    && test -s "/out/lvis-plugin-ep-${EP_API_SHA}.zip"

ENTRYPOINT ["/bin/true"]
