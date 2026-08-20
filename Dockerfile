FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

# DATABASE_URL is deliberately NOT defaulted here. A relative SQLite path would
# put the database inside the image, where it is recreated empty on every
# redeploy — the bug this replaced. The app throws at boot if it is missing in
# production, so supply it at deploy time.

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
