FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
EXPOSE 8080
CMD ["node", "server.js"]
