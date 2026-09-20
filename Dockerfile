FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# The repository currently keeps source/static files at root.
# Prepare the expected build folders automatically.
RUN mkdir -p src public \
    && cp ./*.ts src/ \
    && cp index.html app.js styles.css public/

RUN npm run build


FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

EXPOSE 3000

CMD ["node", "dist/server.js"]
