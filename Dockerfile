FROM node:slim

WORKDIR /express
COPY . .
RUN npm install

ENV PORT=3001
EXPOSE 3001
CMD ["npm","run","start"]