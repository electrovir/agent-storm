# agent-storm

Installs and starts [agent-storm](https://github.com/electrovir/agent-storm), a local web app for running AI coding sessions beside a shell in each of your git repos.

## Usage

```bash
npx agent-storm
```

The first run downloads the latest release from GitHub and installs it under `~/.agent-storm`. Every run then starts agent-storm in the background, if it isn't already running, and opens it in your browser. agent-storm updates itself after that, so this package only needs to run again to reopen it.
