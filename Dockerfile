FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./
COPY public/ ./public/

RUN mkdir -p uploads

EXPOSE 3000
VOLUME ["/app/uploads"]

CMD ["node", "server.js"]
