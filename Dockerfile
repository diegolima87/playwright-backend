FROM node:20-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=0

WORKDIR /app

COPY package*.json ./
RUN npm install

RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
