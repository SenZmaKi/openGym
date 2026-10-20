# Build from the repository root: docker build -f mcp/Dockerfile .
FROM node:22-alpine
WORKDIR /app/mcp
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY mcp/src ./src
COPY frontend/src/lib /app/frontend/src/lib
COPY api/openapi.yaml /app/api/openapi.yaml
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=3001 DATABASE_PATH=/app/data/opengym-mcp.sqlite
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
