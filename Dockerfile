FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY .env.example ./.env.example
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/panel.db
EXPOSE 8080
CMD ["node", "src/server.js"]
