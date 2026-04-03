FROM node:20-alpine
RUN npm install -g npm@latest
WORKDIR /app
COPY package*.json ./
RUN npm install
RUN npm install --no-save @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node
COPY . .
CMD ["node", "index.js"]
