FROM node:20-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=0
ENV NODE_ENV=production

WORKDIR /app

COPY package*.json ./
RUN npm ci

RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
