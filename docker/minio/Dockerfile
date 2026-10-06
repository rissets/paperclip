ARG MINIO_BUILDER_IMAGE=golang:1.25.3-alpine3.22@sha256:aee43c3ccbf24fdffb7295693b6e33b21e01baec1b2a55acc351fde345e9ec34

FROM --platform=$BUILDPLATFORM ${MINIO_BUILDER_IMAGE} AS minio-builder
ARG TARGETARCH
ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_COMMIT=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

RUN apk add --no-cache ca-certificates git
RUN git clone --depth 1 --branch "$MINIO_RELEASE" https://github.com/minio/minio.git /src \
    && test "$(git -C /src rev-parse HEAD)" = "$MINIO_COMMIT"
WORKDIR /src
COPY docker/minio/healthcheck.go /tmp/healthcheck.go
RUN mkdir -p /out/data /out/tmp /out/home/minio \
    && printf 'minio:x:10001:10001:MinIO:/home/minio:/sbin/nologin\n' > /out/passwd \
    && printf 'minio:x:10001:\n' > /out/group \
    && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -tags kqueue -trimpath \
       --ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/minio . \
    && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath \
       -ldflags="-s -w" -o /out/minio-healthcheck /tmp/healthcheck.go \
    && chown -R 10001:10001 /out/data /out/tmp /out/home

FROM scratch AS minio-server
COPY --from=minio-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=minio-builder --chown=10001:10001 /out/minio /usr/local/bin/minio
COPY --from=minio-builder --chown=10001:10001 /out/minio-healthcheck /usr/local/bin/minio-healthcheck
COPY --from=minio-builder --chown=10001:10001 /out/data /data
COPY --from=minio-builder --chown=10001:10001 /out/tmp /tmp
COPY --from=minio-builder --chown=10001:10001 /out/home/minio /home/minio
COPY --from=minio-builder /out/passwd /etc/passwd
COPY --from=minio-builder /out/group /etc/group
ENV HOME=/home/minio
USER 10001:10001
VOLUME ["/data"]
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
HEALTHCHECK --interval=5s --timeout=3s --retries=20 --start-period=15s CMD ["/usr/local/bin/minio-healthcheck"]

FROM --platform=$BUILDPLATFORM ${MINIO_BUILDER_IMAGE} AS mc-builder
ARG TARGETARCH
ARG MINIO_MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ARG MINIO_MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096
RUN apk add --no-cache ca-certificates git
RUN git clone --depth 1 --branch "$MINIO_MC_RELEASE" https://github.com/minio/mc.git /src \
    && test "$(git -C /src rev-parse HEAD)" = "$MINIO_MC_COMMIT"
WORKDIR /src
RUN mkdir -p /out \
    && CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -trimpath \
    --ldflags "$(go run buildscripts/gen-ldflags.go)" -o /out/mc .

FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412 AS minio-client
COPY --from=mc-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=mc-builder /out/mc /usr/local/bin/mc
ENTRYPOINT ["/usr/local/bin/mc"]
