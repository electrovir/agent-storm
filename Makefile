.PHONY: check test lint all publish

PACKAGE_DIR = terminal-ui

all: check test lint

check:
	cd $(PACKAGE_DIR) && cargo check

test:
	cd $(PACKAGE_DIR) && cargo test

lint:
	cd $(PACKAGE_DIR) && cargo clippy -- -D warnings

publish:
	./$(PACKAGE_DIR)/scripts/publish.sh
