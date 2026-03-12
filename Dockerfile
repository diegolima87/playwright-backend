FROM node:20-bookworm-slim

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=0

COPY package*.json ./
RUN npm install --omit=dev

RUN npx playwright install chromium --with-deps

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
