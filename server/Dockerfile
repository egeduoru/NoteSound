FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server ./server
USER node
ENV HOST=0.0.0.0 PORT=3001
EXPOSE 3001
CMD ["node","server/index.mjs"]
