FROM nginx:alpine

# Remove default server config to avoid duplicate default_server directive
RUN rm /etc/nginx/conf.d/default.conf

# Create app-locations dir as a mount point for dynamic route configs
RUN mkdir -p /etc/nginx/app-locations

COPY conf.d/deploykit.conf /etc/nginx/conf.d/deploykit.conf
COPY unauthorized.html /usr/share/nginx/html/unauthorized.html

EXPOSE 80
