#!/bin/sh
# omatic-launch.sh — the process the host actually spawns.
#
# Rule #284 requires a plugin to declare a compatibility tier. Nothing verified
# it at runtime, and the reason is structural: the check everyone reached for
# lived inside server/index.js, which is Node. If Node is missing, index.js
# never executes, so a probe in there is code that only runs in the case where
# it is not needed. The detection has to sit one layer below Node — in whatever
# the host spawns — which is this file.
#
# The manifest points at /bin/sh (absolute, present on every macOS and Linux
# host, and resolvable without a login shell PATH) rather than at `node`. A GUI
# host gets PATH=/usr/bin:/bin:/usr/sbin:/sbin, so a bare `node` in the manifest
# is unresolvable and the server is never spawned — KB-0418 defect A. The host
# then reports no tools, which from inside a session is indistinguishable from a
# factory that failed to resolve (KB-0417).
#
# Two outcomes, never a third:
#   1. A usable Node is found  -> exec the real server. Nothing changes.
#   2. No usable Node is found -> exec the degraded server, which speaks MCP and
#      publishes one tool that names the cause. The tool surface is never zero,
#      so the failure is loud instead of silent.

set -u

MIN_MAJOR=18

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
PLUGIN_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd) || exit 1
SERVER_ENTRY="$PLUGIN_ROOT/server/index.js"
DEGRADED="$SCRIPT_DIR/omatic-degraded-server.sh"

# Why a candidate was rejected, carried through to the degraded server so the
# operator is told "found v16, need v18" rather than a flat "not found".
found_but_old=""

# Return 0 when $1 is a Node binary at or above MIN_MAJOR.
usable_node() {
    _candidate=$1
    [ -n "$_candidate" ] || return 1
    [ -x "$_candidate" ] || return 1

    _ver=$("$_candidate" -v 2>/dev/null) || return 1
    case "$_ver" in
        v[0-9]*) ;;
        *) return 1 ;;
    esac

    _major=${_ver#v}
    _major=${_major%%.*}
    case "$_major" in
        ''|*[!0-9]*) return 1 ;;
    esac

    if [ "$_major" -lt "$MIN_MAJOR" ]; then
        found_but_old="$_candidate ($_ver)"
        return 1
    fi
    return 0
}

# Search order. Explicit operator override first, then PATH (correct on any
# terminal-launched host), then the absolute locations a GUI host cannot see.
# The version-manager globs are deliberately unquoted so the shell expands them;
# a glob that matches nothing stays literal and simply fails the -x test.
NODE_BIN=""

# Test/demo hook. Advisory mode is the one path that cannot be exercised on a
# machine that works, so without this the fallback would ship untested — which
# is the exact failure class rule #284 exists to prevent. It also lets an
# operator see what a broken install looks like before shipping one.
if [ "${OMATIC_FORCE_NO_RUNTIME:-0}" = "1" ]; then
    found_but_old=""
elif usable_node "${OMATIC_NODE:-}"; then
    NODE_BIN=$OMATIC_NODE
else
    _path_node=$(command -v node 2>/dev/null) || _path_node=""
    if usable_node "$_path_node"; then
        NODE_BIN=$_path_node
    else
        for _candidate in \
            /opt/homebrew/bin/node \
            /usr/local/bin/node \
            /usr/bin/node \
            "$HOME/.local/bin/node" \
            "$HOME/.volta/bin/node" \
            "$HOME/.bun/bin/node" \
            "$HOME"/.nvm/versions/node/*/bin/node \
            "$HOME"/.fnm/node-versions/*/installation/bin/node \
            "$HOME"/.asdf/installs/nodejs/*/bin/node \
            "$HOME"/Library/Caches/*/node \
            /snap/bin/node
        do
            if usable_node "$_candidate"; then
                NODE_BIN=$_candidate
                break
            fi
        done
    fi
fi

if [ -n "$NODE_BIN" ]; then
    # Export the resolved path so the server can report the runtime it is
    # actually running on as a measurement rather than a declaration.
    OMATIC_RESOLVED_NODE=$NODE_BIN
    export OMATIC_RESOLVED_NODE
    exec "$NODE_BIN" "$SERVER_ENTRY" "$@"
fi

# No usable runtime. Degrade loudly rather than dying silently.
if [ -n "$found_but_old" ]; then
    OMATIC_RUNTIME_ERROR="found Node $found_but_old but this server requires Node >= $MIN_MAJOR"
else
    OMATIC_RUNTIME_ERROR="no Node runtime found on PATH or in any known install location"
fi
export OMATIC_RUNTIME_ERROR
export OMATIC_MIN_NODE_MAJOR="$MIN_MAJOR"

# Carry the real version to the advisory server. It cannot require Node to read
# package.json — that is the runtime it is reporting the absence of — so the
# value is lifted with sed here rather than hardcoded there. A literal in the
# fallback would be a second source of truth for a version number, which is the
# drift KB-0414 Step 5 exists to stop.
OMATIC_PLUGIN_VERSION=$(
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PLUGIN_ROOT/package.json" 2>/dev/null | head -1
)
export OMATIC_PLUGIN_VERSION="${OMATIC_PLUGIN_VERSION:-unknown}"

if [ -r "$DEGRADED" ]; then
    exec /bin/sh "$DEGRADED"
fi

# The degraded server is missing too. Nothing left but stderr, which at least
# reaches the host log — the first place KB-0417 says to look.
echo "[omatic-server-connection] FATAL: $OMATIC_RUNTIME_ERROR, and the degraded server at $DEGRADED is missing." >&2
exit 1
