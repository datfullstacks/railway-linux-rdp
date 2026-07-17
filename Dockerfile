FROM ubuntu:24.04

ARG MLX_DEB_URL=https://cdn-mlx-prod.multiloginapp.com/desktop/latest/desktop-multilogin-ubuntu-24.04-amd64.deb
ARG MLX_DEB_SHA256=F56E8798E283EC390BAB2C802D9E4AFE360100E02EAA4C1F237A31BE5BF1BC5D
ARG CHROME_DEB_URL=https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
ARG CHROME_DEB_SHA256=83ED59C85878EBB8FA53915EBE7066CAFC58D1C04C1C95449486E6F9D99A1EFB

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dbus-x11 \
        fonts-liberation \
        fonts-noto-color-emoji \
        locales \
        supervisor \
        sudo \
        xauth \
        xdg-utils \
        xorgxrdp \
        xrdp \
        xfce4 \
        xfce4-terminal \
    && curl -fsSL "${MLX_DEB_URL}" -o /tmp/mlxapp.deb \
    && echo "${MLX_DEB_SHA256}  /tmp/mlxapp.deb" | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/mlxapp.deb \
    && test -x /usr/bin/mlxapp \
    && test -f /usr/share/applications/mlxapp.desktop \
    && curl -fsSL "${CHROME_DEB_URL}" -o /tmp/google-chrome.deb \
    && echo "${CHROME_DEB_SHA256}  /tmp/google-chrome.deb" | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && test -x /usr/bin/google-chrome-stable \
    && test -f /usr/share/applications/google-chrome.desktop \
    && locale-gen en_US.UTF-8 \
    && apt-get clean \
    && rm -f /tmp/mlxapp.deb /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/^AllowRootLogin=.*/AllowRootLogin=false/' /etc/xrdp/sesman.ini

COPY supervisord.conf /etc/supervisor/conf.d/railway-rdp.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY google-chrome-rdp.sh /usr/local/bin/google-chrome-rdp

RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/google-chrome-rdp \
    && update-alternatives --install \
      /usr/bin/x-www-browser \
      x-www-browser \
      /usr/local/bin/google-chrome-rdp \
      300 \
    && update-alternatives --set x-www-browser /usr/local/bin/google-chrome-rdp

EXPOSE 3389

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
