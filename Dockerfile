FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

LABEL org.opencontainers.image.title="SpiLLI API Bridge"
LABEL org.opencontainers.image.description="Anthropic/OpenAI-compatible API bridge for the SpiLLI SDK"
LABEL org.opencontainers.image.source="https://github.com/synaptrixai/spilli-api-bridge"
LABEL org.opencontainers.image.licenses="MIT"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY README.md LICENSE ./

USER node

ENV SPILLI_BRIDGE_HOST=0.0.0.0
ENV SPILLI_BRIDGE_PORT=8888
ENV SPILLI_KEY_PATH=/home/node/.spilli

EXPOSE 8888

CMD ["npm", "start"]
