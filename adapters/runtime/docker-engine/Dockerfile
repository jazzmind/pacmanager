FROM python:3.12-slim

# Install Docker CLI and git
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg lsb-release git && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/debian $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /opt/deploykit
COPY . .
RUN pip install --no-cache-dir "."

# State and workspace directories (will be overridden by volume mounts at runtime)
RUN mkdir -p /var/lib/deploykit /srv/deploykit/apps /etc/nginx/app-locations

ENV DEPLOYKIT_HOST=0.0.0.0
ENV DEPLOYKIT_PORT=8011

EXPOSE 8011

CMD ["deploykit", "serve"]
