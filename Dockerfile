FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=0

COPY package*.json ./

RUN npm install --omit=dev
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 10000

CMD ["npm", "start"]
