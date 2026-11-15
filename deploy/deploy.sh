#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/zevem
target="${DEPLOY_COMMIT:?DEPLOY_COMMIT não informado}"
[[ "$target" =~ ^[0-9a-f]{40}$ ]]
exec 9>.deploy.lock
flock -n 9
test -s .env.production
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Há alterações rastreadas no checkout da VPS."
  exit 1
fi

git fetch origin main
if [[ "$target" != "$(git rev-parse FETCH_HEAD)" ]]; then
  echo "O deploy deve usar o commit atual da main."
  exit 1
fi

previous_checkout="$(git rev-parse HEAD)"
previous_release=""
if [[ -s .last-successful-deploy ]]; then
  read -r previous_release < .last-successful-deploy
  [[ "$previous_release" =~ ^[0-9a-f]{40}$ ]]
fi

applied=0
rollback() {
  local result=$?
  trap - ERR
  if (( applied )); then
    if [[ -n "$previous_release" ]]; then
      if git checkout --detach "$previous_release" &&
        ZEVEM_RELEASE="$previous_release" docker compose up -d --no-build --wait --wait-timeout 120; then
        echo "Containers restaurados para $previous_release. O volume de dados foi preservado."
      else
        echo "Falha ao restaurar os containers de $previous_release."
      fi
    else
      docker compose down || true
      git checkout --detach "$previous_checkout" || true
    fi
  else
    git checkout --detach "$previous_checkout" || true
  fi
  exit "$result"
}
trap rollback ERR

git checkout --detach "$target"
export ZEVEM_RELEASE="$target"
docker compose config --quiet
if [[ "$target" != "$previous_release" ]]; then
  docker compose build
fi
applied=1
docker compose up -d --no-build --wait --wait-timeout 120

app_url=https://app.zevem.com.br
health="$(curl -fsS --retry 4 --retry-delay 2 --max-time 10 "$app_url/api/health")"
[[ "$health" == '{"status":"ok"}' ]]
page="$(curl -fsS --retry 4 --retry-delay 2 --max-time 10 "$app_url/login")"
[[ "$page" == *'<app-root'* ]]
printf '%s\n' "$target" > .last-successful-deploy
trap - ERR
echo "Zevem publicado: $target"
