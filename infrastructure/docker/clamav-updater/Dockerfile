FROM clamav/clamav:stable-debian@sha256:a73435b0fa51886e9e6dd1881656023ba9dce756e055f23981270badbb8ca3d7

# The scanner shares the signature volume read-only and reloads changes using
# clamd's built-in self-check. Removing NotifyClamd keeps this Internet-enabled
# updater off every network that can reach the unauthenticated clamd protocol.
RUN sed -i '/^NotifyClamd[[:space:]]/d' /etc/clamav/freshclam.conf

COPY --chmod=0555 definitions-fresh.sh /usr/local/bin/definitions-fresh

USER 1000:1000
ENTRYPOINT ["/init-unprivileged"]
