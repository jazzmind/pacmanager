FROM node:22-alpine
WORKDIR /worker
COPY definition.js build-worker.js ./
COPY worker-package.json ./package.json
USER 10001:10001
ENTRYPOINT ["node", "/worker/build-worker.js"]
