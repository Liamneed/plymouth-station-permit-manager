FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_FACTOR=2
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

COPY package.json ./

RUN npm config set registry https://registry.npmjs.org/ \
    && npm install --omit=dev --no-audit --no-fund \
       --prefer-online --foreground-scripts --loglevel=verbose

COPY . .

RUN mkdir -p /app/data

EXPOSE 4000

CMD ["node", "server.js"]