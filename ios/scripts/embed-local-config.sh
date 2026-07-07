#!/bin/sh
set -eu

env_file="${SRCROOT}/../.env"
resources_dir="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
config_file="${resources_dir}/CutReadyConfig.plist"

client_id=""
if [ -f "${env_file}" ]; then
  client_id=$(
    awk -F= '$1 == "CUTREADY_GITHUB_OAUTH_CLIENT_ID" {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"|"$/, "", value)
      print value
    }' "${env_file}" | tail -n 1
  )
fi

if [ -z "${client_id}" ]; then
  rm -f "${config_file}"
  exit 0
fi

mkdir -p "${resources_dir}"
cat > "${config_file}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CUTREADY_GITHUB_OAUTH_CLIENT_ID</key>
  <string>${client_id}</string>
</dict>
</plist>
EOF
