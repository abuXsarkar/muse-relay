FROM node:24-bookworm-slim
LABEL org.opencontainers.image.licenses="GPL-3.0-only"
WORKDIR /app
COPY package.json LICENSE ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY public/ ./public/
RUN mkdir -p /var/lib/muse-relay && chown node:node /var/lib/muse-relay
ENV NODE_ENV=production MUSE_BIND_HOST=0.0.0.0 MUSE_DATA_DIR=/var/lib/muse-relay
USER node
EXPOSE 4174
CMD ["node", "scripts/local.mjs"]
