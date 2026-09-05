#!/usr/bin/env bash
set -Eeuo pipefail

readonly project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly install_dir="/opt/opendartboard-match-console"
readonly web_dir="$install_dir/www"
readonly stats_data_dir="${OPENDARTBOARD_STATS_DIR:-/var/lib/opendartboard-match-console/stats}"
readonly board_data_dir="${OPENDARTBOARD_DATA_DIR:-${HOME}/.local/share/opendartboard}"
readonly motion_spike_threshold="${OPENDARTBOARD_MOTION_SPIKE_THRESHOLD:-0.08}"
readonly motion_low_threshold="${OPENDARTBOARD_MOTION_LOW_THRESHOLD:-0.001}"
readonly motion_min_cameras="${OPENDARTBOARD_MOTION_MIN_CAMERAS:-2}"
readonly network_name="opendartboard-console"
readonly control_environment="/etc/default/opendartboard-match-console"

if [[ ! -f "$project_root/dist/client/index.html" ]]; then
  echo "dist/client is missing. Run npm run build first." >&2
  exit 1
fi

sudo install -d -m 0755 "$install_dir" "$web_dir" /run/opendartboard-control
sudo install -d -m 0750 "$stats_data_dir" /var/lib/opendartboard-control
sudo cp -a "$project_root/dist/client/." "$web_dir/"
sudo install -m 0755 "$project_root/server/board_control.py" "$install_dir/board_control.py"
sudo install -m 0644 "$project_root/server/nginx.conf" "$install_dir/nginx.conf"
sudo install -m 0644 "$project_root/server/opendartboard-control.service" /etc/systemd/system/opendartboard-control.service

environment_file="$(mktemp)"
trap 'rm -f "$environment_file"' EXIT
printf 'OPENDARTBOARD_DATA_DIR="%s"\n' "$board_data_dir" >"$environment_file"
printf 'OPENDARTBOARD_MOTION_SPIKE_THRESHOLD="%s"\n' "$motion_spike_threshold" >>"$environment_file"
printf 'OPENDARTBOARD_MOTION_LOW_THRESHOLD="%s"\n' "$motion_low_threshold" >>"$environment_file"
printf 'OPENDARTBOARD_MOTION_MIN_CAMERAS="%s"\n' "$motion_min_cameras" >>"$environment_file"
sudo install -m 0644 "$environment_file" "$control_environment"

sudo systemctl daemon-reload
sudo systemctl enable --now opendartboard-control.service

if ! sudo docker network inspect "$network_name" >/dev/null 2>&1; then
  sudo docker network create "$network_name" >/dev/null
fi

sudo docker build -t opendartboard-match-console-stats:local "$project_root/server"
sudo docker rm --force opendartboard-stats >/dev/null 2>&1 || true
sudo docker run -d \
  --name opendartboard-stats \
  --network "$network_name" \
  --restart unless-stopped \
  --volume "$stats_data_dir:/data" \
  opendartboard-match-console-stats:local >/dev/null

sudo docker rm --force opendartboard-play >/dev/null 2>&1 || true
sudo docker run -d \
  --name opendartboard-play \
  --network "$network_name" \
  --restart unless-stopped \
  --publish 8090:80 \
  --volume "$web_dir:/usr/share/nginx/html:ro" \
  --volume "$install_dir/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  --volume /run/opendartboard-control:/run/opendartboard-control:ro \
  nginx:1.27-alpine >/dev/null

echo "OpenDartboard Match Console is available on port 8090."
