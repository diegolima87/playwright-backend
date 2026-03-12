FROM node:20-bookworm-slim

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=0

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN ./node_modules/.bin/playwright install chromium --with-deps

# smoke test: falha no build se o browser não estiver onde o Playwright espera
RUN node -e "const { chromium } = require('playwright'); console.log('PLAYWRIGHT EXECUTABLE:', chromium.executablePath())"

EXPOSE 3000

CMD ["node", "server.js"]
