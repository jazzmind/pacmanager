FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY demo ./demo
# demo/runtime-adapter.js and demo/graduation-adapter.js import from ../src/adapters.js --
# found live: this image never worked with a runtime adapter configured at all before this
# fix (ERR_MODULE_NOT_FOUND, since only demo/ was ever copied in).
COPY src ./src
USER 10001:10001
ENV HOST=0.0.0.0 PAC_DATA_DIR=/data PAC_BUILD_MODE=kubernetes
EXPOSE 3000
CMD ["node","demo/server.js"]
