FROM node:22-alpine AS build

ENV NUXT_TELEMETRY_DISABLED=1
WORKDIR /app

# postinstall runs `nuxt prepare`, which reads the config and the app: they come before the packages
COPY package.json package-lock.json nuxt.config.ts tsconfig.json ./
COPY app ./app
COPY server ./server
RUN npm ci
RUN npm run build


FROM node:22-alpine

ENV NODE_ENV=production NUXT_TELEMETRY_DISABLED=1 NITRO_HOST=0.0.0.0 NITRO_PORT=8100
WORKDIR /app

COPY --from=build /app/.output ./.output

USER node
EXPOSE 8100
CMD ["node", ".output/server/index.mjs"]
