# pty-layout zsh init wrapper (ZDOTDIR=<shim>/shell-init). When ZDOTDIR is
# set, zsh reads its rc files from here instead of $HOME. We delegate to
# the user's real rc files so their shell stays normal, then re-prepend
# PTY_LAYOUT_SHIM_DIR to PATH in .zshrc so the tmux shim wins over real
# tmux.

[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
