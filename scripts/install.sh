#!/bin/sh
set -eu
export LC_ALL=C

fail() {
    printf 'agy-api installer: %s\n' "$*" >&2
    exit 1
}

usage() {
    printf '%s\n' 'Usage: install.sh [--version vX.Y.Z | --from-dir DIR]' \
        'Installs and starts agy-api, with automatic startup at boot.'
}

version=
source_dir=
while [ "$#" -gt 0 ]; do
    case "$1" in
        --version)
            [ "$#" -ge 2 ] || fail 'Missing release tag after --version.'
            case "$2" in
                *[!a-z0-9.-]*) fail 'Expected a release tag like v0.1.0.' ;;
            esac
            printf '%s\n' "$2" | grep -Eq '^(agy-api-)?v[0-9]+\.[0-9]+\.[0-9]+$' ||
                fail 'Expected a release tag like v0.1.0.'
            version=$2
            shift
            ;;
        --from-dir)
            [ "$#" -ge 2 ] && [ -d "$2" ] || fail 'Pass a release directory after --from-dir.'
            source_dir=$2
            shift
            ;;
        --enable-linger) ;; # Accept existing install commands.
        -h|--help) usage; exit 0 ;;
        *) fail "Unknown option: $1" ;;
    esac
    shift
done
[ -z "$version" ] || [ -z "$source_dir" ] || fail 'Use either --version or --from-dir.'
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail 'Requires Linux x86_64.'
libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'Requires glibc 2.27 or newer.'
case "$libc" in
    'glibc '*) libc=${libc#glibc } ;;
    *) fail 'Requires glibc 2.27 or newer.' ;;
esac
awk -v version="$libc" 'BEGIN {
    split(version, parts, /[.]/)
    exit !(parts[1] > 2 || (parts[1] == 2 && parts[2] >= 27))
}' || fail 'Requires glibc 2.27 or newer.'
command -v systemctl >/dev/null || fail 'Requires systemd and its systemctl command.'
command -v loginctl >/dev/null || fail 'Requires systemd and its loginctl command.'

asset=agy-api-linux-x86_64
release=https://github.com/jeffusion/opencode-antigrvity/releases
bindir=${HOME:?Set HOME}/.local/bin
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
data_home=${XDG_DATA_HOME:-$HOME/.local/share}
for path in "$HOME" "$config_home" "$data_home"; do
    case "$path" in
        /*) ;;
        *) fail 'HOME, XDG_CONFIG_HOME and XDG_DATA_HOME must be absolute paths.' ;;
    esac
done
confdir=$config_home/agy-api
env_file=$confdir/agy-api.env
unitdir=$config_home/systemd/user
unit=agy-api.service

umask 077
mkdir -p -- "$bindir"
stage=$(mktemp -d "$bindir/.agy-api.XXXXXXXX")
config_stage=
unit_stage=
trap 'rm -rf -- "$stage"; [ -z "$config_stage" ] || rm -rf -- "$config_stage"; [ -z "$unit_stage" ] || rm -f -- "$unit_stage"' 0
trap 'exit 1' 1 2 15

if [ -n "$source_dir" ]; then
    for file in "$asset" "$asset.sha256"; do
        cp -- "$source_dir/$file" "$stage/$file" || fail "Could not copy $file."
    done
else
    download=$release/latest/download
    [ -z "$version" ] || download=$release/download/$version
    for file in "$asset" "$asset.sha256"; do
        curl -q --proto '=https' --proto-redir '=https' -fsSL --retry 3 --connect-timeout 10 --max-time 300 \
            -o "$stage/$file" "$download/$file" || fail "Could not download $file."
    done
fi

# Read the digest as data, never a filename from the checksum.
expected=$(awk -v asset="$asset" '
    NR == 1 && length($1) == 64 && $1 !~ /[^[:xdigit:]]/ &&
        (substr($0, 65) == "  " asset || substr($0, 65) == " *" asset) {
        digest = tolower($1)
    }
    END {
        if (NR != 1 || digest == "") exit 1
        print digest
    }
' "$stage/$asset.sha256") || fail "Expected one SHA-256 checksum for $asset."
actual=$(sha256sum < "$stage/$asset")
[ "${actual%% *}" = "$expected" ] || fail "SHA-256 mismatch for $asset."
chmod 0755 -- "$stage/$asset"
"$stage/$asset" --help > "$stage/help" && grep -Fxq 'Usage: agy-api' "$stage/help" ||
    fail 'The verified binary did not pass its --help check.'

account=$(id -un)
if [ "$(loginctl show-user "$account" -p Linger --value 2>/dev/null || true)" != yes ]; then
    loginctl enable-linger "$account" ||
        fail "Could not enable boot startup. Ask an administrator to run: sudo loginctl enable-linger $account"
fi
if [ "$(id -u)" = 0 ]; then
    # A root shell opened with sudo may have no root systemd user session.
    systemctl start user@0.service || fail 'Could not start the root systemd user manager.'
    export XDG_RUNTIME_DIR=/run/user/0
    unset DBUS_SESSION_BUS_ADDRESS
fi

mkdir -p -- "$confdir" "$unitdir"
if [ ! -e "$env_file" ] && [ ! -L "$env_file" ]; then
    config_stage=$(mktemp -d "$confdir/.agy-api.XXXXXXXX")
    key=$(od -An -N32 -tx1 /dev/urandom) || fail 'Could not generate an API key.'
    key=$(printf '%s' "$key" | tr -d '[:space:]')
    [ "${#key}" -eq 64 ] || fail 'Could not generate an API key.'
    credentials=$(printf '%s' "$data_home/agy-api/credentials" | sed 's/[\\"]/\\&/g')
    printf 'AGY_API_KEY=%s\nAGY_PORT=8787\nAGY_CREDENTIALS_DIR="%s"\n' "$key" "$credentials" \
        > "$config_stage/env"
    unset key
    # Link only if absent so concurrent installs also keep the first key.
    ln -T -- "$config_stage/env" "$env_file" || [ -f "$env_file" ] ||
        fail "Could not create $env_file."
fi
[ -f "$env_file" ] && [ ! -L "$env_file" ] || fail "Expected a regular file at $env_file."
chmod 0600 -- "$env_file"

unit_stage=$(mktemp "$unitdir/.agy-api.XXXXXXXX")
cat > "$unit_stage" <<'UNIT'
[Unit]
Description=Antigravity API service

[Service]
Type=exec
ExecStart=%h/.local/bin/agy-api
EnvironmentFile=%E/agy-api/agy-api.env
Restart=on-failure
RestartSec=10s
KillMode=mixed
TimeoutStopSec=30s
UMask=0077

[Install]
WantedBy=default.target
UNIT
chmod 0644 -- "$unit_stage"
mv -fT -- "$unit_stage" "$unitdir/$unit"

action=start
if [ -e "$bindir/agy-api" ]; then
    action=restart
fi
mv -fT -- "$stage/$asset" "$bindir/agy-api"

systemctl --user daemon-reload && systemctl --user enable "$unit" && systemctl --user "$action" "$unit" ||
    fail "Installed at $bindir/agy-api, but systemd setup failed. Run: systemctl --user daemon-reload && systemctl --user enable $unit && systemctl --user restart $unit"
printf 'agy-api installed at %s\nEnvironment file: %s\n' "$bindir/agy-api" "$env_file"
