FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

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
