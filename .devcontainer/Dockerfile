FROM mcr.microsoft.com/devcontainers/base:jammy

ARG M2_COMMON_DEB_URL="https://macaulay2.com/Downloads/Common/Macaulay2-1.21-common.deb"
ARG M2_UBUNTU_DEB_URL="https://macaulay2.com/Repositories/Ubuntu/dists/jammy/main/binary-amd64/Macaulay2-1.21-amd64-Linux-Ubuntu-22.04.deb"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && mkdir -p /tmp/macaulay2 \
    && curl -fsSL "${M2_COMMON_DEB_URL}" -o /tmp/macaulay2/Macaulay2-common.deb \
    && curl -fsSL "${M2_UBUNTU_DEB_URL}" -o /tmp/macaulay2/Macaulay2-jammy.deb \
    && apt-get install -y --no-install-recommends \
        /tmp/macaulay2/Macaulay2-common.deb \
        /tmp/macaulay2/Macaulay2-jammy.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/macaulay2
