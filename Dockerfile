FROM node:slim

WORKDIR /express
COPY . .
RUN npm install

ENV PORT=3000
EXPOSE 3000
CMD ["npm","run","start"]