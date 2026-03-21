FROM node:20-bookworm

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=0
ENV PORT=10000

COPY package*.json ./

RUN npm install

COPY . .

RUN npx playwright install --with-deps chromium

EXPOSE 10000

CMD ["npm", "start"]
