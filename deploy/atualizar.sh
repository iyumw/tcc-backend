#!/usr/bin/env bash
# Atualiza o backend no servidor com o que está no GitHub.
# Uso (no servidor, na pasta tcc-backend): bash deploy/atualizar.sh
set -e
git pull
npm ci --omit=dev
sudo systemctl restart safe-evidence
sleep 2
curl -fsS http://127.0.0.1:8080/health && echo " <- backend no ar"
