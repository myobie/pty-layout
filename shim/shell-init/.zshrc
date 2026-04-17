# pty-layout zsh init wrapper. Runs AFTER the user's normal zshrc so our
# PATH override wins over anything the user's rc did (e.g. brew shellenv).

[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"

if [[ -n "${PTY_LAYOUT_SHIM_DIR:-}" ]]; then
  export PATH="$PTY_LAYOUT_SHIM_DIR:$PATH"
fi
