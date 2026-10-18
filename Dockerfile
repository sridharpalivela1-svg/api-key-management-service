FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install curl/wget for convenience
RUN apk add --no-cache wget

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code and scripts
COPY . .

# Expose API port
EXPOSE 3000

# Set default environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Start application
CMD ["npm", "start"]
