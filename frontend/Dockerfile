FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy dashboard files
COPY public/ /usr/share/nginx/html/public/
COPY public/index.html /usr/share/nginx/html/index.html

EXPOSE 80
