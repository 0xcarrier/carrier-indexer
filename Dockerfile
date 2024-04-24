FROM node:18.19-alpine

RUN apk update

# install build dependencies
RUN apk add \
    wget \
    python3 \
    py3-pip \
    gcc \
    make \
    musl \
    musl-dev \
    g++ \
    libc-dev

WORKDIR /

COPY . ./

RUN npm install && npm run build

EXPOSE 27001

ENTRYPOINT ["sh", "docker-entrypoint.sh"]