FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY data ./data
COPY test ./test

# Fail the image build when parser, Rift logic, or index.js syntax regresses.
RUN npm test

EXPOSE 3000

CMD ["node", "src/index.js"]
