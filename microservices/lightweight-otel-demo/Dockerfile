FROM node:20-alpine
RUN npm install -g npm@latest

WORKDIR /app

# Copy package info and install dependencies
COPY package*.json ./
RUN npm install
RUN npm install --no-save @opentelemetry/api @opentelemetry/auto-instrumentations-node @opentelemetry/sdk-node

# Copy application source code
COPY . .

# Environment variables
ENV PORT=8080

EXPOSE 8080 8081 8082

# Start command will be overridden by docker-compose
CMD ["npm", "run", "start:gateway"]
