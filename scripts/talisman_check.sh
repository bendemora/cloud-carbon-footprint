#!/bin/sh

# Runs the Talisman git hook (pre-commit by default) and locates the Talisman
# install in this order:
#   1. $TALISMAN_HOME/talisman_hook_script  (Talisman's global installer layout)
#   2. a `talisman` binary on PATH           (e.g. `brew install talisman`)
# If neither is found the hook fails, exactly as upstream's hook does, but with
# a message that says what to install.

hook="${1:-pre-commit}"

if [ -n "$TALISMAN_HOME" ] && [ -x "$TALISMAN_HOME/talisman_hook_script" ]; then
    exec "$TALISMAN_HOME/talisman_hook_script" "$hook"
fi

if command -v talisman >/dev/null 2>&1; then
    exec talisman --githook "$hook"
fi

echo "ERROR: Talisman is required for the $hook hook but was not found." >&2
echo "       Set TALISMAN_HOME (Talisman's global installer) or put a 'talisman'" >&2
echo "       binary on PATH (e.g. brew install talisman). See CONTRIBUTING.md." >&2
exit 1
