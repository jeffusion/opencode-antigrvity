#!/bin/sh
set -eu

[ "$#" -eq 1 ] || { printf '%s\n' 'Usage: test-install.sh RELEASE_DIR' >&2; exit 1; }
release=$(cd -- "$1" && pwd -P)
installer=$(cd -- "$(dirname -- "$0")" && pwd -P)/install.sh
asset=agy-api-linux-x86_64
scratch=$(mktemp -d /tmp/agy-api-install-test.XXXXXXXX)
trap 'rm -rf -- "$scratch"' 0
trap 'exit 1' 1 2 15
test_home=$scratch/home
test_config=$scratch/config
test_data="$scratch/custom data"
bin=$test_home/.local/bin/agy-api
env_file=$test_config/agy-api/agy-api.env
unit_file=$test_config/systemd/user/agy-api.service
log=$scratch/commands
output=$scratch/output
mkdir -- "$scratch/mock" "$test_home" "$scratch/bad"

cat > "$scratch/mock/systemctl" <<'MOCK'
#!/bin/sh
set -eu
case "$*" in
    '--user daemon-reload'|'--user enable agy-api.service'|'--user start agy-api.service'|'--user restart agy-api.service') ;;
    *) exit 2 ;;
esac
printf 'systemctl %s\n' "$*" >> "$TEST_LOG"
[ "$MOCK_RELOAD_FAIL" = 0 ] || [ "$*" != '--user daemon-reload' ]
MOCK
cat > "$scratch/mock/getconf" <<'MOCK'
#!/bin/sh
set -eu
[ "$*" = GNU_LIBC_VERSION ]
if [ "$MOCK_OLD_GLIBC" = 1 ]; then
    printf 'glibc 2.26\n'
else
    exec /usr/bin/getconf "$@"
fi
MOCK
cat > "$scratch/mock/loginctl" <<'MOCK'
#!/bin/sh
set -eu
account=$(id -un)
printf 'loginctl %s\n' "$*" >> "$TEST_LOG"
case "$*" in
    "show-user $account -p Linger --value") printf '%s\n' "$MOCK_LINGER_STATE" ;;
    "enable-linger $account") [ "$MOCK_LINGER_FAIL" = 0 ] ;;
    *) exit 2 ;;
esac
MOCK
cat > "$scratch/mock/curl" <<'MOCK'
#!/bin/sh
set -eu
[ "$#" -eq 15 ] && [ "$*" = "-q --proto =https --proto-redir =https -fsSL --retry 3 --connect-timeout 10 --max-time 300 -o ${14} ${15}" ]
printf 'curl %s\n' "${15}" >> "$TEST_LOG"
case "$MOCK_CURL_FAIL:${15##*/}" in
    1:*.sha256) exit 22 ;;
esac
cp -- "$TEST_RELEASE/${15##*/}" "${14}"
MOCK
chmod +x -- "$scratch/mock/"*

run_install() {
    : > "$log"
    env -i HOME="$test_home" XDG_CONFIG_HOME="$test_config" XDG_DATA_HOME="$test_data" \
        TMPDIR="$scratch" PATH="$scratch/mock:/usr/bin:/bin" TEST_LOG="$log" TEST_RELEASE="$release" \
        MOCK_CURL_FAIL="${MOCK_CURL_FAIL:-0}" MOCK_LINGER_FAIL="${MOCK_LINGER_FAIL:-0}" \
        MOCK_LINGER_STATE="${MOCK_LINGER_STATE:-no}" \
        MOCK_RELOAD_FAIL="${MOCK_RELOAD_FAIL:-0}" MOCK_OLD_GLIBC="${MOCK_OLD_GLIBC:-0}" \
        sh "$installer" "$@" > "$output" 2>&1
}

expect_failure() {
    diagnostic=$1
    shift
    if run_install "$@"; then
        printf 'Unexpected success for %s\n' "$*" >&2
        exit 1
    fi
    grep -Fq -- "$diagnostic" "$output" || { cat "$output" >&2; exit 1; }
    cmp -- "$release/$asset" "$bin"
    cmp -- "$scratch/saved.env" "$env_file"
    if [ -n "${bin_inode:-}" ]; then
        [ "$(stat -c %i "$bin")" = "$bin_inode" ]
    fi
}

run_install --from-dir "$release" || { cat "$output" >&2; exit 1; }
cmp -- "$release/$asset" "$bin"
[ "$(stat -c %a "$bin")" = 755 ]
[ "$(stat -c %a "$env_file")" = 600 ]
[ "$(stat -c %u "$env_file")" = "$(id -u)" ]
[ "$(stat -c %a "$unit_file")" = 644 ]
grep -Fxq 'ExecStart=%h/.local/bin/agy-api' "$unit_file"
grep -Fxq 'Type=exec' "$unit_file"
grep -Fxq 'EnvironmentFile=%E/agy-api/agy-api.env' "$unit_file"
grep -Fxq 'Restart=on-failure' "$unit_file"
grep -Fxq 'RestartSec=10s' "$unit_file"
grep -Fxq 'KillMode=mixed' "$unit_file"
grep -Fxq 'TimeoutStopSec=30s' "$unit_file"
grep -Fxq 'WantedBy=default.target' "$unit_file"
grep -Fxq "AGY_CREDENTIALS_DIR=\"$test_data/agy-api/credentials\"" "$env_file"
key=$(sed -n 's/^AGY_API_KEY=//p' "$env_file")
printf '%s\n' "$key" | grep -Eq '^[a-f0-9]{64}$'
if grep -Fq -- "$key" "$output"; then
    printf '%s\n' 'Installer printed the API key.' >&2
    exit 1
fi
unset key
diff -u - "$log" <<LOG
loginctl show-user $(id -un) -p Linger --value
loginctl enable-linger $(id -un)
systemctl --user daemon-reload
systemctl --user enable agy-api.service
systemctl --user start agy-api.service
LOG

sed -i 's/^AGY_PORT=.*/AGY_PORT=18787/' "$env_file"
cp -- "$env_file" "$scratch/saved.env"
chmod 0644 -- "$env_file"
first_inode=$(stat -c %i "$bin")
MOCK_LINGER_STATE=yes run_install --version agy-api-v1.2.3 --enable-linger || { cat "$output" >&2; exit 1; }
[ "$(stat -c %i "$bin")" != "$first_inode" ]
cmp -- "$scratch/saved.env" "$env_file"
[ "$(stat -c %a "$env_file")" = 600 ]
diff -u - "$log" <<LOG
curl https://github.com/jeffusion/opencode-antigrvity/releases/download/agy-api-v1.2.3/$asset
curl https://github.com/jeffusion/opencode-antigrvity/releases/download/agy-api-v1.2.3/$asset.sha256
loginctl show-user $(id -un) -p Linger --value
systemctl --user daemon-reload
systemctl --user enable agy-api.service
systemctl --user restart agy-api.service
LOG

bin_inode=$(stat -c %i "$bin")
MOCK_LINGER_FAIL=1 expect_failure 'Ask an administrator to run: sudo loginctl enable-linger'
diff -u - "$log" <<LOG
curl https://github.com/jeffusion/opencode-antigrvity/releases/latest/download/$asset
curl https://github.com/jeffusion/opencode-antigrvity/releases/latest/download/$asset.sha256
loginctl show-user $(id -un) -p Linger --value
loginctl enable-linger $(id -un)
LOG
unset bin_inode

MOCK_LINGER_STATE=yes MOCK_RELOAD_FAIL=1 expect_failure 'Run: systemctl --user daemon-reload && systemctl --user enable agy-api.service && systemctl --user restart agy-api.service' --from-dir "$release"
diff -u - "$log" <<LOG
loginctl show-user $(id -un) -p Linger --value
systemctl --user daemon-reload
LOG

bin_inode=$(stat -c %i "$bin")
MOCK_OLD_GLIBC=1 expect_failure 'Requires glibc 2.27 or newer.' --from-dir "$release"
[ ! -s "$log" ]
MOCK_CURL_FAIL=1 expect_failure 'Could not download'
diff -u - "$log" <<LOG
curl https://github.com/jeffusion/opencode-antigrvity/releases/latest/download/$asset
curl https://github.com/jeffusion/opencode-antigrvity/releases/latest/download/$asset.sha256
LOG

printf '#!/bin/sh\nprintf "unexpected executable\\n"\n' > "$scratch/bad/$asset"
cp -- "$release/$asset.sha256" "$scratch/bad/$asset.sha256"
expect_failure 'SHA-256 mismatch' --from-dir "$scratch/bad"
[ ! -s "$log" ]

(
    cd -- "$scratch/bad"
    sha256sum "$asset" > "$asset.sha256"
)
expect_failure 'did not pass its --help check' --from-dir "$scratch/bad"
[ ! -s "$log" ]

sed -i "s|  $asset\$|  ../../$asset|" "$scratch/bad/$asset.sha256"
expect_failure 'Expected one SHA-256 checksum' --from-dir "$scratch/bad"
[ ! -s "$log" ]

cat "$release/$asset.sha256" "$release/$asset.sha256" > "$scratch/bad/$asset.sha256"
expect_failure 'Expected one SHA-256 checksum' --from-dir "$scratch/bad"
[ ! -s "$log" ]

printf '%s\n' 'Installer checks passed.'
