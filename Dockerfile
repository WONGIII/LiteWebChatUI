FROM node:22-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public/ ./public/

RUN mkdir -p uploads

EXPOSE 3000
VOLUME ["/app/uploads"]

CMD ["node", "server.js"]
