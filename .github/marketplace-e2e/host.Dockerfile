FROM oven/bun:1.3.14

USER root
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcairo2 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnss3 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libxcomposite1 \
      libxrandr2 \
      libxshmfence1 \
      libxss1 \
      python3 \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 lvis \
    && useradd --create-home --uid 10001 --gid 10001 --shell /bin/bash lvis \
    && mkdir -p /workspace/lvis-app /workspace/lvis-plugin-sdk /evidence \
    && chown -R 10001:10001 /workspace /evidence

COPY --chown=10001:10001 lvis-app/ /workspace/lvis-app/
COPY --chown=10001:10001 lvis-plugin-sdk/ /workspace/lvis-plugin-sdk/

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
WORKDIR /workspace/lvis-app
RUN bun install --frozen-lockfile \
    && bun run test:plugin-bundle-inputs \
    && bun run build

ENTRYPOINT ["/bin/bash"]
