# Build stage: install dependencies and generate the Prisma client for this platform.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate

# Runtime stage: production dependencies, non-root user, no build toolchain.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --chown=app:app package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=app:app --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=app:app --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app src ./src
COPY --chown=app:app tsconfig.json ./
USER app
EXPOSE 4000
CMD ["sh", "-c", "npx prisma db push --skip-generate && node --import tsx src/index.ts"]
