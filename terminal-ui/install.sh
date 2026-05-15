#!/usr/bin/env bash
set -euo pipefail

REPO="electrovir/agent-storm"
BINARY_NAME="agent-storm"

echo "Installing agent-storm..."

# Detect OS and architecture.
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Darwin)
        case "$ARCH" in
            arm64) TARGET="aarch64-apple-darwin" ;;
            x86_64) TARGET="x86_64-apple-darwin" ;;
            *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        ;;
    Linux)
        case "$ARCH" in
            aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
            x86_64) TARGET="x86_64-unknown-linux-gnu" ;;
            *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
        esac
        ;;
    *)
        echo "Unsupported OS: $OS"
        exit 1
        ;;
esac

# Determine install directory.
if [ "$(uname)" = "Linux" ] && [ -d "$HOME/.local/bin" ]; then
    INSTALL_DIR="$HOME/.local/bin"
else
    INSTALL_DIR="/usr/local/bin"
fi

# Fetch the latest release tag from GitHub.
echo "Fetching latest release..."
LATEST_TAG=$(curl --proto '=https' --tlsv1.2 -sL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
    echo "Error: could not determine latest release."
    exit 1
fi

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$BINARY_NAME-$TARGET.tar.gz"

echo "Downloading $BINARY_NAME $LATEST_TAG for $TARGET..."

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl --proto '=https' --tlsv1.2 -sL "$DOWNLOAD_URL" -o "$TMPDIR/agent-storm.tar.gz"
tar xzf "$TMPDIR/agent-storm.tar.gz" -C "$TMPDIR"

if [ ! -f "$TMPDIR/$BINARY_NAME" ]; then
    echo "Error: binary not found in archive."
    exit 1
fi

chmod +x "$TMPDIR/$BINARY_NAME"

# Strip macOS quarantine attribute so Gatekeeper doesn't block the binary.
if [ "$(uname)" = "Darwin" ]; then
    xattr -d com.apple.quarantine "$TMPDIR/$BINARY_NAME" 2>/dev/null || true
fi

echo "Installing to $INSTALL_DIR..."

if [ -w "$INSTALL_DIR" ]; then
    cp "$TMPDIR/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
    ln -sf "$INSTALL_DIR/$BINARY_NAME" "$INSTALL_DIR/ags"
else
    sudo cp "$TMPDIR/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
    sudo ln -sf "$INSTALL_DIR/$BINARY_NAME" "$INSTALL_DIR/ags"
fi

echo ""
echo "Installed agent-storm $LATEST_TAG to $INSTALL_DIR"
echo "Run with: agent-storm  or  ags"
