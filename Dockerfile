FROM node:22
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# 强制 Railway 使用 8080 端口
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]