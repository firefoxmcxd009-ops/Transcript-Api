FROM node:18-bullseye

# ដំឡើង ffmpeg សម្រាប់បម្លែង Video ទៅ Audio
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5000

CMD ["npm", "start"]
