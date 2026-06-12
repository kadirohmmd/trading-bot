FROM node:20-alpine
WORKDIR /app
COPY bot.js .
CMD ["node", "bot.js"]