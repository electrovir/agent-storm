#!/usr/bin/env bash
set -euo pipefail

# Publish script for agent-storm.
#
# Scenarios handled:
#   1. Current version tag doesn't exist        -> create tag, test, push
#   2. Current version tag exists locally only   -> move tag to HEAD, test, push
#   3. Current version tag is already on remote  -> bump version, commit, tag, test, push
#
# Commit prefix conventions (at the start of the commit message):
#   [major] — breaking changes (1.2.3 -> 2.0.0)
#   [minor] — new features (1.2.3 -> 1.3.0)
#   [patch] — bug fixes (1.2.3 -> 1.2.4)
#
# If no prefix is found in any commit since the last tag, the script aborts.

REPO_ROOT="$(git rev-parse --show-toplevel)"

# --- Step 0: Check for uncommitted changes ---
if [ -n "$(git status --porcelain)" ]; then
    echo "Error: there are uncommitted changes. Commit or stash them first."
    exit 1
fi

# --- Step 1: Read current version from Cargo.toml ---
CURRENT_VERSION=$(grep '^version' "$REPO_ROOT/Cargo.toml" | head -1 | sed -E 's/version = "(.*)"/\1/')
TAG="v$CURRENT_VERSION"
echo "Current Cargo.toml version: $CURRENT_VERSION"

# --- Step 2: Determine scenario ---
TAG_EXISTS_LOCALLY=false
TAG_EXISTS_ON_REMOTE=false

if git tag --list "$TAG" | grep -q "$TAG"; then
    TAG_EXISTS_LOCALLY=true
fi

if git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
    TAG_EXISTS_ON_REMOTE=true
fi

if $TAG_EXISTS_ON_REMOTE; then
    # --- Scenario 3: Already released. Bump version. ---
    echo "$TAG is already released on GitHub. Determining next version..."

    COMMITS=$(git log "$TAG"..HEAD --pretty=format:"%s" 2>/dev/null || true)

    if [ -z "$COMMITS" ]; then
        echo "No new commits since $TAG. Nothing to publish."
        exit 0
    fi

    # Highest bump wins: major > minor > patch.
    BUMP_TYPE=""

    while IFS= read -r msg; do
        prefix=$(echo "$msg" | grep -oE '^\[[a-zA-Z]+\]' | tr -d '[]' | tr '[:upper:]' '[:lower:]' || true)
        case "$prefix" in
            major) BUMP_TYPE="major" ;;
            minor) [ "$BUMP_TYPE" != "major" ] && BUMP_TYPE="minor" ;;
            patch) [ -z "$BUMP_TYPE" ] && BUMP_TYPE="patch" ;;
        esac
    done <<< "$COMMITS"

    if [ -z "$BUMP_TYPE" ]; then
        echo "Error: no semver prefix ([major], [minor], or [patch]) found in commits since $TAG."
        echo "Commits since $TAG:"
        echo "$COMMITS"
        exit 1
    fi

    IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

    case "$BUMP_TYPE" in
        major)
            MAJOR=$((MAJOR + 1))
            MINOR=0
            PATCH=0
            ;;
        minor)
            MINOR=$((MINOR + 1))
            PATCH=0
            ;;
        patch)
            PATCH=$((PATCH + 1))
            ;;
    esac

    NEXT_VERSION="$MAJOR.$MINOR.$PATCH"
    NEXT_TAG="v$NEXT_VERSION"
    echo "Bump type: $BUMP_TYPE ($CURRENT_VERSION -> $NEXT_VERSION)"

    # Update Cargo.toml
    sed -i '' -E "s/^version = \"$CURRENT_VERSION\"/version = \"$NEXT_VERSION\"/" "$REPO_ROOT/Cargo.toml"
    echo "Updated Cargo.toml to $NEXT_VERSION"

    # Update Cargo.lock
    (cd "$REPO_ROOT" && cargo check --quiet 2>/dev/null || true)

    # Commit and tag
    git add "$REPO_ROOT/Cargo.toml" "$REPO_ROOT/Cargo.lock"
    git commit -m "v$NEXT_VERSION"
    git tag "$NEXT_TAG"
    echo "Created tag $NEXT_TAG"

    TAG="$NEXT_TAG"

elif $TAG_EXISTS_LOCALLY; then
    # --- Scenario 2: Tag exists locally but not on remote. Move to HEAD. ---
    TAG_COMMIT=$(git rev-list -n 1 "$TAG")
    HEAD_COMMIT=$(git rev-parse HEAD)

    if [ "$TAG_COMMIT" != "$HEAD_COMMIT" ]; then
        echo "$TAG exists locally but is not on HEAD. Moving tag to HEAD..."
        git tag -f "$TAG"
    else
        echo "$TAG is already on HEAD."
    fi

else
    # --- Scenario 1: Tag doesn't exist at all. Create it. ---
    echo "$TAG does not exist. Creating tag on HEAD..."
    git tag "$TAG"
fi

# --- Step 3: Run tests ---
echo "Running tests..."
(cd "$REPO_ROOT" && make all)

# --- Step 4: Push ---
echo "Pushing..."
git push
git push --tags

echo ""
echo "Published $TAG"
