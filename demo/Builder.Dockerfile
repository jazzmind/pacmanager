FROM node:22-alpine
WORKDIR /worker
COPY demo/definition.js demo/build-worker.js ./
COPY demo/worker-package.json ./package.json
USER 10001:10001
ENTRYPOINT ["node", "/worker/build-worker.js"]
