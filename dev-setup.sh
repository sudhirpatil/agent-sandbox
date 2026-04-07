#!/bin/zsh
# ═══════════════════════════════════════════════════════════
#  AI Agent Sandbox — Dev Setup & Run Guide
#  Usage: bash dev-setup.sh [command]
#
#  Commands:
#    setup   — create venv and install all dependencies (first time)
#    run     — start the dev server
#    update  — upgrade all pip packages to latest
#    clean   — remove venv and __pycache__ (start fresh)
#    (none)  — print this help
# ═══════════════════════════════════════════════════════════

set -e

VENV_DIR="venv"
APP_HOST="0.0.0.0"
APP_PORT="8000"

# ── Colours ────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}▶ $*${RESET}"; }
success() { echo -e "${GREEN}✔ $*${RESET}"; }
warn()    { echo -e "${YELLOW}⚠ $*${RESET}"; }
error()   { echo -e "${RED}✖ $*${RESET}"; exit 1; }
section() { echo -e "\n${BOLD}$*${RESET}"; }

# ── Helper: ensure venv exists ─────────────────────────────
require_venv() {
  if [ ! -d "$VENV_DIR" ]; then
    error "Virtual environment not found. Run:  bash dev-setup.sh setup"
  fi
}

# ── Helper: activate venv ─────────────────────────────────
activate() {
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
}

# ══════════════════════════════════════════════════════════
#  SETUP
# ══════════════════════════════════════════════════════════
cmd_setup() {
  section "1 · Python version check"
  python3 --version || error "python3 not found. Install Python 3.11+ and retry."
  PYTHON_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")
  if [ "$PYTHON_MINOR" -lt 11 ]; then
    warn "Python 3.11+ is recommended (found 3.${PYTHON_MINOR})"
  fi

  section "2 · Create virtual environment"
  if [ -d "$VENV_DIR" ]; then
    warn "venv already exists — skipping creation"
  else
    python3 -m venv "$VENV_DIR"
    success "venv created at ./${VENV_DIR}/"
  fi

  section "3 · Install dependencies"
  activate
  pip install --upgrade pip --quiet
  pip install -r requirements.txt --quiet
  success "All packages installed"

  section "4 · Environment file"
  if [ ! -f .env ]; then
    cp .env.example .env
    warn ".env created from .env.example"
    warn "Open .env and fill in your API keys before running:"
    echo "    ANTHROPIC_API_KEY=sk-ant-..."
    echo "    OPENAI_API_KEY=sk-..."
    echo "    GOOGLE_API_KEY=AI..."
  else
    success ".env already exists"
  fi

  section "Done ✔"
  echo -e "Run the app with:  ${BOLD}bash dev-setup.sh run${RESET}"
}

# ══════════════════════════════════════════════════════════
#  RUN
# ══════════════════════════════════════════════════════════
cmd_run() {
  require_venv
  activate

  section "Checking .env"
  if [ ! -f .env ]; then
    error ".env not found. Run:  bash dev-setup.sh setup"
  fi

  # Warn about missing keys (non-fatal — user may only need one provider)
  for KEY in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY; do
    VALUE=$(grep -E "^${KEY}=" .env | cut -d= -f2 | tr -d '[:space:]')
    if [ -z "$VALUE" ] || [ "$VALUE" = "your_anthropic_key_here" ] || \
       [ "$VALUE" = "your_openai_key_here" ] || [ "$VALUE" = "your_google_key_here" ]; then
      warn "${KEY} is not set (models from that provider won't work)"
    fi
  done

  section "Starting server"
  echo -e "  URL : ${BOLD}http://localhost:${APP_PORT}${RESET}"
  echo -e "  Logs: uvicorn with --reload (auto-restarts on file changes)"
  echo -e "  Stop: Ctrl+C\n"

  uvicorn app.main:app --reload --host "$APP_HOST" --port "$APP_PORT"
}

# ══════════════════════════════════════════════════════════
#  UPDATE
# ══════════════════════════════════════════════════════════
cmd_update() {
  require_venv
  activate
  section "Upgrading all packages"
  pip install --upgrade pip --quiet
  pip install --upgrade -r requirements.txt
  success "Packages updated"
}

# ══════════════════════════════════════════════════════════
#  CLEAN
# ══════════════════════════════════════════════════════════
cmd_clean() {
  section "Cleaning project"
  if [ -d "$VENV_DIR" ]; then
    rm -rf "$VENV_DIR"
    success "Removed venv/"
  fi
  find . -type d -name "__pycache__" ! -path "./.git/*" -exec rm -rf {} + 2>/dev/null || true
  find . -name "*.pyc" ! -path "./.git/*" -delete 2>/dev/null || true
  success "Removed __pycache__ and .pyc files"
  echo -e "Run setup again with:  ${BOLD}bash dev-setup.sh setup${RESET}"
}

# ══════════════════════════════════════════════════════════
#  HELP
# ══════════════════════════════════════════════════════════
cmd_help() {
  echo -e "
${BOLD}AI Agent Sandbox — Dev Setup${RESET}

${BOLD}USAGE${RESET}
  bash dev-setup.sh <command>

${BOLD}COMMANDS${RESET}
  ${CYAN}setup${RESET}    Create virtualenv, install packages, scaffold .env
  ${CYAN}run${RESET}      Start the FastAPI dev server on http://localhost:${APP_PORT}
  ${CYAN}update${RESET}   Upgrade all pip packages to their latest versions
  ${CYAN}clean${RESET}    Delete venv and all __pycache__ / .pyc files

${BOLD}QUICK START (first time)${RESET}
  1.  bash dev-setup.sh setup
  2.  Edit .env  — add ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY
  3.  bash dev-setup.sh run
  4.  Open http://localhost:${APP_PORT}

${BOLD}REQUIREMENTS${RESET}
  • Python 3.11+
  • pip
  • API key for at least one provider (Anthropic / OpenAI / Google)
"
}

# ── Dispatch ───────────────────────────────────────────────
case "${1:-help}" in
  setup)  cmd_setup  ;;
  run)    cmd_run    ;;
  update) cmd_update ;;
  clean)  cmd_clean  ;;
  help|--help|-h) cmd_help ;;
  *) warn "Unknown command: $1"; cmd_help ;;
esac
