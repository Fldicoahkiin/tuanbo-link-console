#!/bin/sh
set -eu

# Other certificates on this shared host keep their existing renewal behavior.
if [ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/tuanbo-link.jinhefilm.com ]; then
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
fi
