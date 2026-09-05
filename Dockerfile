# syntax=docker/dockerfile:1
# Self-contained abeam API + Mineflayer bot runtime for Railway.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Railway injects PORT at runtime. The application defaults to 8080 locally.
EXPOSE 8080
VOLUME ["/app/data"]

CMD ["npm", "start"]
