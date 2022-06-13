FROM node:13.8.0-alpine3.11

# Create app directory
WORKDIR /app

# Bundle app source
COPY . .
RUN apk add curl

EXPOSE 8080
CMD [ "npm", "run", "start" ]