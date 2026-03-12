FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
RUN npx playwright install --with-deps chromium
CMD ["node", "server.js"]
