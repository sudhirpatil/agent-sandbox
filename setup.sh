#!/bin/bash
set -e

echo "Setting up AI Agent Sandbox..."

# Create virtual environment
python3 -m venv venv
echo "Virtual environment created."

# Activate and install dependencies
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
echo "Dependencies installed."

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    echo ".env created from .env.example — add your ANTHROPIC_API_KEY"
fi

echo ""
echo "Setup complete! Run: ./run.sh"
