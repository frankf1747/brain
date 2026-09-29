FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY tsconfig.json ./
ENV NODE_ENV=production PORT=8080 BRAIN_LLM=api
USER node
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "src/mcp/http-main.ts"]
