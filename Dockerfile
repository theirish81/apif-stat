FROM node:13-alpine3.10
COPY . /opt/apif-stat
WORKDIR /opt/apif-stat
RUN npm install
CMD ["node","main.js"]
