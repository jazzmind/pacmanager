FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY demo ./demo
USER 10001:10001
ENV HOST=0.0.0.0 PAC_DATA_DIR=/data PAC_BUILD_MODE=kubernetes
EXPOSE 3000
CMD ["node","demo/server.js"]
