#!/bin/bash
# Install this file as a root-owned executable Certbot deploy hook.
set -Eeuo pipefail
umask 077

lineage="${RENEWED_LINEAGE:-}"
lineage="${lineage%/}"
case "$lineage" in
    /etc/letsencrypt/live/mathbot.site)
        cert_name=fullchain.pem; key_name=privkey.pem ;;
    /etc/letsencrypt/live/support.mathbot.site)
        cert_name=support_fullchain.pem; key_name=support_privkey.pem ;;
    /etc/letsencrypt/live/ylearn.mathbot.site)
        cert_name=ylearn_fullchain.pem; key_name=ylearn_privkey.pem ;;
    /etc/letsencrypt/live/bus.mathbot.site)
        cert_name=bus_fullchain.pem; key_name=bus_privkey.pem ;;
    *) exit 0 ;;
esac

if (( EUID != 0 )); then
    printf 'This hook must run as root.\n' >&2
    exit 1
fi

exec 9>/run/lock/certbot-nginx-deploy.lock
flock -w 60 9

cert_dir=/opt/nginx-proxy/certs
container=nginx-proxy-nginx-1
cert="$cert_dir/$cert_name"
key="$cert_dir/$key_name"
test -f "$cert"
test -f "$key"

# Check the new pair before changing any files, including for an unused vhost.
openssl x509 -in "$lineage/fullchain.pem" -checkend 0 -noout >/dev/null
cert_public=$(openssl x509 -in "$lineage/fullchain.pem" -pubkey -noout |
    openssl pkey -pubin -outform DER | sha256sum)
key_public=$(openssl pkey -in "$lineage/privkey.pem" -pubout -outform DER |
    sha256sum)
if [[ "$cert_public" != "$key_public" ]]; then
    printf 'Certificate and key do not match: %s\n' "$lineage" >&2
    exit 1
fi

# Refuse to publish into an already broken Nginx configuration.
docker exec "$container" nginx -t
install -o root -g root -m 644 "$cert" "$cert.previous"
install -o root -g root -m 600 "$key" "$key.previous"

publish_started=0
finish() {
    result=$?
    trap - EXIT
    if (( result != 0 && publish_started == 1 )); then
        printf 'Deployment failed; restoring previous Nginx files.\n' >&2
        if ! install -o root -g root -m 644 "$cert.previous" "$cert" ||
           ! install -o root -g root -m 600 "$key.previous" "$key"; then
            printf 'Restore failed; backups remain in %s.\n' "$cert_dir" >&2
        fi
    fi
    rm -f -- "$cert.new" "$key.new"
    exit "$result"
}
trap finish EXIT

install -o root -g root -m 644 "$lineage/fullchain.pem" "$cert.new"
install -o root -g root -m 600 "$lineage/privkey.pem" "$key.new"
publish_started=1
mv -f -- "$cert.new" "$cert"
mv -f -- "$key.new" "$key"
docker exec "$container" nginx -t
docker exec "$container" nginx -s reload
publish_started=0
printf 'Installed certificate for %s; Nginx reload requested.\n' "${lineage##*/}"
