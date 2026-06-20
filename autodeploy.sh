#!/bin/bash
# Auto-deploy script for JDA Trade Monitor
# Polls GitHub repository every 60 seconds and auto-deploys on new changes.

echo "=========================================================="
echo "Starting Auto-Deploy daemon for JDA Trade Monitor..."
echo "Target: origin/main"
echo "Interval: 60 seconds"
echo "=========================================================="

# Ensure we are in the repository root directory
cd "$(dirname "$0")"

while true; do
  # Fetch latest references from remote
  git fetch origin main &>/dev/null
  
  if [ $? -eq 0 ]; then
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse origin/main)
    
    if [ "$LOCAL" != "$REMOTE" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') - [AutoDeploy] New commits detected on origin/main!"
      echo "Local:  $LOCAL"
      echo "Remote: $REMOTE"
      
      echo "Executing git pull..."
      git pull origin main
      
      echo "Restarting PM2 process 'trading-dashboard'..."
      pm2 restart "trading-dashboard"
      
      echo "Auto-deploy complete."
    fi
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') - [AutoDeploy] Failed to fetch from origin."
  fi
  
  sleep 60
done
