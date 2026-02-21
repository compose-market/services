#!/bin/bash
# MCP Compiler Runner Script
#
# Usage:
#   ./run.sh              # Run all phases
#   ./run.sh --phase 1    # Only metadata cleaning
#   ./run.sh --phase 2    # Only spawning
#   ./run.sh --test       # Test mode (5 servers)
#   ./run.sh --resume     # Resume from checkpoint

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check Python dependencies
if ! python3 -c "import requests, pydantic, tqdm" 2>/dev/null; then
    echo "Installing Python dependencies..."
    pip3 install -r requirements.txt -q
fi

# Check Node dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing Node dependencies..."
    npm install --silent
fi

# Check for .env file
if [ ! -f ".env" ]; then
    echo "Warning: No .env file found. Using defaults."
    echo "Create .env from .env.example for CloudFlare API access."
fi

# Run compiler
echo "Starting MCP Compiler..."
python3 compiler.py "$@"