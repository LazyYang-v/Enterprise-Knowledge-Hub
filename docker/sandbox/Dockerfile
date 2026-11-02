FROM node:24-bookworm-slim

RUN groupadd --gid 10001 sandbox \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

WORKDIR /sandbox
COPY --chown=root:root server/tools/sandbox-worker.js /sandbox/sandbox-worker.js

USER 10001:10001
ENV NODE_ENV=production

ENTRYPOINT ["node", "/sandbox/sandbox-worker.js"]
